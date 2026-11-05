//! Fabrication de la source RFC 5322 d'un message (brouillon, copie envoyée, import) avec mail-builder,
//! et retrait du Bcc avant l'envoi SMTP. Port de `composeMime` et `stripBcc` : le Bcc reste dans la
//! source enregistrée, il ne part jamais chez les destinataires.

use std::sync::LazyLock;

use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address as MbAddress;
use mail_builder::headers::message_id::MessageId;
use mail_builder::headers::raw::Raw;
use regex::bytes::Regex;

use crate::headers::Address;

/// Fin du bloc d'en-têtes.
static HEADER_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n\r?\n").unwrap());
/// Fin de ligne d'en-tête.
static LINE_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
/// Ligne `Bcc:` (casse ignorée ; `Resent-Bcc` n'est pas concerné).
static BCC_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^bcc\s*:").unwrap());

#[derive(Debug, Clone, Default)]
pub struct ComposeInput {
    pub from: Vec<Address>,
    pub sender: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: Option<String>,
    pub sent_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub message_id: String,
    pub in_reply_to: Vec<String>,
    pub references: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<Attachment>,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct Attachment {
    pub filename: Option<String>,
    pub content: Vec<u8>,
    pub content_type: String,
    pub cid: Option<String>,
    pub inline: bool,
}

fn address(a: &Address) -> MbAddress<'static> {
    let name = a.name.as_ref().filter(|n| !n.is_empty()).cloned();
    MbAddress::new_address(name, a.email.clone())
}

fn list(addrs: &[Address]) -> MbAddress<'static> {
    MbAddress::new_list(addrs.iter().map(address).collect())
}

fn bare_id(id: &str) -> String {
    let id = id.strip_prefix('<').unwrap_or(id);
    id.strip_suffix('>').unwrap_or(id).to_string()
}

fn message_ids(ids: &[String]) -> MessageId<'static> {
    MessageId::new_list(ids.iter().map(|i| bare_id(i)))
}

/// Extension déduite du type, pour nommer une pièce sans nom (`attachment-<n>.<ext>`, comme nodemailer).
fn extension(content_type: &str) -> &'static str {
    match content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "text/plain" => "txt",
        "text/html" => "html",
        "text/calendar" => "ics",
        "text/csv" => "csv",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        "message/rfc822" => "eml",
        _ => "bin",
    }
}

/// Construit la source RFC 5322 (Bcc conservé : c'est un brouillon ; il est retiré à l'envoi).
pub fn compose_mime(input: &ComposeInput) -> Vec<u8> {
    let mut b = MessageBuilder::new();
    if !input.from.is_empty() {
        b = b.from(list(&input.from));
    }
    if let Some(first) = input.sender.first() {
        b = b.sender(address(first));
    }
    if !input.to.is_empty() {
        b = b.to(list(&input.to));
    }
    if !input.cc.is_empty() {
        b = b.cc(list(&input.cc));
    }
    if !input.bcc.is_empty() {
        b = b.bcc(list(&input.bcc));
    }
    if !input.reply_to.is_empty() {
        b = b.reply_to(list(&input.reply_to));
    }
    if !input.in_reply_to.is_empty() {
        b = b.in_reply_to(message_ids(&input.in_reply_to));
    }
    if !input.references.is_empty() {
        b = b.references(message_ids(&input.references));
    }
    if let Some(subject) = input.subject.as_ref().filter(|s| !s.is_empty()) {
        b = b.subject(subject.clone());
    }
    b = b.message_id(bare_id(&input.message_id));
    let date = input
        .sent_at
        .map(|d| d.timestamp())
        .unwrap_or_else(|| chrono::Utc::now().timestamp());
    b = b.date(date);
    for (name, value) in &input.headers {
        b = b.header(name.clone(), Raw::new(value.clone()));
    }
    if let Some(text) = &input.text {
        b = b.text_body(text.clone());
    }
    if let Some(html) = &input.html {
        b = b.html_body(html.clone());
    }
    for (i, a) in input.attachments.iter().enumerate() {
        let content = a.content.clone();
        match (&a.cid, input.html.is_some()) {
            (Some(cid), true) => b = b.inline(a.content_type.clone(), bare_id(cid), content),
            _ => {
                let name = a
                    .filename
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| {
                        format!("attachment-{}.{}", i + 1, extension(&a.content_type))
                    });
                b = b.attachment(a.content_type.clone(), name, content);
            }
        }
    }
    b.write_to_vec().unwrap_or_default()
}

/// Retire les en-têtes Bcc d'une source RFC 5322 avant envoi SMTP.
pub fn strip_bcc(raw: &[u8]) -> Vec<u8> {
    let end = HEADER_END.find(raw).map(|m| m.start()).unwrap_or(raw.len());
    let head = &raw[..end];
    let mut kept: Vec<&[u8]> = Vec::new();
    let mut skipping = false;
    for l in LINE_END.split(head) {
        if l.first().is_some_and(|c| *c == b' ' || *c == b'\t') {
            if !skipping {
                kept.push(l);
            }
            continue;
        }
        skipping = BCC_LINE.is_match(l);
        if !skipping {
            kept.push(l);
        }
    }
    let mut out = kept.join(&b"\r\n"[..]);
    out.extend_from_slice(&raw[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::{MessageParser, MimeHeaders};

    fn addr(name: Option<&str>, email: &str) -> Address {
        Address {
            name: name.map(str::to_string),
            email: email.to_string(),
        }
    }

    #[test]
    fn composition_relue() {
        let input = ComposeInput {
            from: vec![addr(Some("Alex Martin"), "alex@ex.fr")],
            to: vec![addr(None, "bob@ex.fr"), addr(Some("Chloé"), "chloe@ex.fr")],
            bcc: vec![addr(None, "cache@ex.fr")],
            subject: Some("Réunion d'équipe".into()),
            sent_at: Some(
                chrono::DateTime::parse_from_rfc3339("2026-11-05T10:00:00+01:00").unwrap(),
            ),
            message_id: "<abc@ex.fr>".into(),
            in_reply_to: vec!["p1@ex.fr".into()],
            references: vec!["<r0@ex.fr>".into(), "p1@ex.fr".into()],
            text: Some("Bonjour".into()),
            html: Some("<p>Bonjour <img src=\"cid:logo@ex\"></p>".into()),
            attachments: vec![
                Attachment {
                    filename: Some("note.txt".into()),
                    content: b"contenu".to_vec(),
                    content_type: "text/plain".into(),
                    cid: None,
                    inline: false,
                },
                Attachment {
                    filename: None,
                    content: vec![0x89, b'P', b'N', b'G'],
                    content_type: "image/png".into(),
                    cid: Some("logo@ex".into()),
                    inline: true,
                },
            ],
            headers: vec![("X-Voxel".into(), "oui".into())],
            ..ComposeInput::default()
        };
        let raw = compose_mime(&input);
        let m = MessageParser::new().parse(&raw).unwrap();
        assert_eq!(m.subject(), Some("Réunion d'équipe"));
        assert_eq!(m.message_id(), Some("abc@ex.fr"));
        let from = m.from().unwrap().first().unwrap();
        assert_eq!(
            (from.name.as_deref(), from.address.as_deref()),
            (Some("Alex Martin"), Some("alex@ex.fr"))
        );
        assert_eq!(m.to().unwrap().iter().count(), 2);
        assert_eq!(
            m.bcc().unwrap().first().unwrap().address.as_deref(),
            Some("cache@ex.fr")
        );
        assert_eq!(m.body_text(0).as_deref(), Some("Bonjour"));
        assert!(m.body_html(0).unwrap().contains("cid:logo@ex"));
        assert_eq!(m.date().unwrap().to_timestamp(), 1_793_869_200);
        let names: Vec<Option<&str>> = m.attachments().map(|a| a.attachment_name()).collect();
        assert!(names.contains(&Some("note.txt")));
        let logo = m
            .attachments()
            .find(|a| a.content_id() == Some("logo@ex"))
            .expect("image cid");
        assert_eq!(logo.contents(), &[0x89, b'P', b'N', b'G']);
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("X-Voxel: oui"));
        assert!(text.contains("In-Reply-To: <p1@ex.fr>"));
    }

    #[test]
    fn piece_sans_nom_et_sujet_vide() {
        let input = ComposeInput {
            from: vec![addr(None, "a@ex.fr")],
            subject: Some(String::new()),
            message_id: "id@ex".into(),
            text: Some("x".into()),
            attachments: vec![Attachment {
                filename: None,
                content: b"%PDF".to_vec(),
                content_type: "application/pdf".into(),
                cid: Some("c".into()),
                inline: true,
            }],
            ..ComposeInput::default()
        };
        let raw = compose_mime(&input);
        let m = MessageParser::new().parse(&raw).unwrap();
        assert_eq!(m.subject(), None);
        assert_eq!(
            m.attachments().next().unwrap().attachment_name(),
            Some("attachment-1.pdf")
        );
    }

    #[test]
    fn retrait_du_bcc() {
        let raw = b"From: a@ex.fr\r\nBcc: x@ex.fr,\r\n y@ex.fr\r\nResent-Bcc: z@ex.fr\r\nSubject: s\r\n\r\nBcc: corps\r\n";
        let out = strip_bcc(raw);
        assert_eq!(
            out,
            b"From: a@ex.fr\r\nResent-Bcc: z@ex.fr\r\nSubject: s\r\n\r\nBcc: corps\r\n"
        );
        assert_eq!(strip_bcc(b"BCC : x\nTo: y\n\ncorps"), b"To: y\n\ncorps");
    }
}
