//! En-têtes bruts d'un message : découpe du bloc renvoyé par `FETCH BODY[HEADER.FIELDS]`, mots encodés
//! RFC 2047, identifiants de message, URL et adresses (ports de `mime.ts`, mêmes expressions régulières),
//! plus l'enveloppe et les dates lues par mail-parser (l'ENVELOPE IMAP n'est plus demandée).

use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};
use regex::Regex;

use crate::decode::{decode_base64, decode_charset, decode_quoted_printable};

/// Deux mots encodés séparés seulement par des blancs : les blancs disparaissent (RFC 2047 §6.2).
static ADJACENT_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(=\?[^?]+\?[QqBb]\?[^?]*\?=)").unwrap()
});
/// Un mot encodé : jeu de caractères, encodage (Q ou B), texte.
static ENCODED_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"=\?([^?]+)\?([QqBb])\?([^?]*)\?=").unwrap());
/// Identifiant entre chevrons.
static MESSAGE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<([^<>\s]+)>").unwrap());
/// URL entre chevrons (List-Unsubscribe, List-Post…).
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<([^<>]+)>").unwrap());
/// Une adresse d'une liste : les virgules entre guillemets ou chevrons ne séparent pas.
static ADDRESS_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"("[^"]*"|<[^>]*>|[^,])+"#).unwrap());
/// `Nom <adresse>`.
static NAME_ADDR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)<([^>]+)>\s*$").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct RawHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Default)]
pub struct Envelope {
    pub date: Option<DateTime<FixedOffset>>,
    pub subject: Option<String>,
    pub from: Vec<Address>,
    pub sender: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
}

/// Découpe un bloc d'en-têtes en liste ordonnée (valeurs dépliées, sans le nom).
pub fn parse_header_block(bytes: &[u8]) -> Vec<RawHeader> {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    let mut out: Vec<RawHeader> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with([' ', '\t'])
            && let Some(last) = out.last_mut()
        {
            last.value.push(' ');
            last.value.push_str(line.trim());
            continue;
        }
        let Some(i) = line.find(':') else { continue };
        if i == 0 {
            continue;
        }
        out.push(RawHeader {
            name: line[..i].trim().to_string(),
            value: line[i + 1..].trim().to_string(),
        });
    }
    out
}

/// Valeurs de l'en-tête `name` (casse ignorée), dans l'ordre du bloc.
pub fn header_values<'a>(headers: &'a [RawHeader], name: &str) -> Vec<&'a str> {
    let low = name.to_lowercase();
    headers
        .iter()
        .filter(|h| h.name.to_lowercase() == low)
        .map(|h| h.value.as_str())
        .collect()
}

pub fn parse_message_ids(value: Option<&str>) -> Option<Vec<String>> {
    let value = value.filter(|v| !v.is_empty())?;
    let ids: Vec<String> = MESSAGE_ID
        .captures_iter(value)
        .map(|c| c[1].to_string())
        .collect();
    if !ids.is_empty() {
        return Some(ids);
    }
    let bare: Vec<String> = value
        .split_whitespace()
        .filter(|x| x.contains('@'))
        .map(str::to_string)
        .collect();
    if bare.is_empty() { None } else { Some(bare) }
}

pub fn parse_urls(value: &str) -> Option<Vec<String>> {
    let urls: Vec<String> = URL
        .captures_iter(value)
        .map(|c| c[1].split_whitespace().collect::<String>())
        .collect();
    if urls.is_empty() { None } else { Some(urls) }
}

fn strip_quotes(s: &str) -> &str {
    let s = s.strip_prefix('"').unwrap_or(s);
    s.strip_suffix('"').unwrap_or(s)
}

/// Analyse simple d'une liste d'adresses (en-tête brut).
pub fn parse_addresses(value: &str) -> Option<Vec<Address>> {
    let decoded = decode_words(value);
    let mut out = Vec::new();
    for m in ADDRESS_ITEM.find_iter(&decoded) {
        let p = m.as_str().trim();
        if p.is_empty() {
            continue;
        }
        if let Some(c) = NAME_ADDR.captures(p) {
            let name = strip_quotes(c[1].trim()).trim();
            out.push(Address {
                name: if name.is_empty() {
                    None
                } else {
                    Some(name.to_string())
                },
                email: c[2].trim().to_string(),
            });
        } else {
            out.push(Address {
                name: None,
                email: strip_quotes(p).to_string(),
            });
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Décode les mots encodés RFC 2047 d'une valeur d'en-tête.
pub fn decode_words(value: &str) -> String {
    let mut joined = value.to_string();
    loop {
        let next = ADJACENT_WORDS.replace_all(&joined, "$1$2").into_owned();
        if next == joined {
            break;
        }
        joined = next;
    }
    ENCODED_WORD
        .replace_all(&joined, |c: &regex::Captures<'_>| {
            let charset = c[1].split('*').next().unwrap_or("");
            let text = c[3].as_bytes();
            let bytes = if c[2].eq_ignore_ascii_case("B") {
                let mut b: Vec<u8> = text.to_vec();
                while !b.len().is_multiple_of(4) {
                    b.push(b'=');
                }
                decode_base64(&b, false)
            } else {
                decode_quoted_printable(text, true)
            };
            decode_charset(&bytes, Some(charset))
        })
        .into_owned()
}

fn to_chrono(d: &mail_parser::DateTime) -> Option<DateTime<FixedOffset>> {
    let secs = (d.tz_hour as i32) * 3600 + (d.tz_minute as i32) * 60;
    let offset = FixedOffset::east_opt(if d.tz_before_gmt { -secs } else { secs })?;
    let naive = NaiveDate::from_ymd_opt(d.year as i32, d.month as u32, d.day as u32)?.and_hms_opt(
        d.hour as u32,
        d.minute as u32,
        d.second as u32,
    )?;
    offset.from_local_datetime(&naive).single()
}

/// Date RFC 5322 lue par mail-parser (remplace `new Date()` de V8 pour `asDate`).
pub fn parse_date(value: &str) -> Option<DateTime<FixedOffset>> {
    let block = format!("Date: {value}\r\n\r\n");
    let msg = mail_parser::MessageParser::new().parse_headers(block.as_bytes())?;
    msg.date().and_then(to_chrono)
}

fn addresses(a: Option<&mail_parser::Address<'_>>) -> Vec<Address> {
    let conv = |x: &mail_parser::Addr<'_>| {
        let email = x.address.as_deref().unwrap_or("").trim().to_string();
        let name = x
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
        if email.is_empty() && name.is_none() {
            None
        } else {
            Some(Address { name, email })
        }
    };
    match a {
        Some(mail_parser::Address::List(list)) => list.iter().filter_map(conv).collect(),
        Some(mail_parser::Address::Group(groups)) => groups
            .iter()
            .flat_map(|g| g.addresses.iter())
            .filter_map(conv)
            .collect(),
        None => Vec::new(),
    }
}

/// Enveloppe lue dans le bloc d'en-têtes (`Date`, `Subject`, adresses, `Message-ID`, `In-Reply-To`).
pub fn envelope(header_block: &[u8]) -> Envelope {
    let Some(msg) = mail_parser::MessageParser::new().parse_headers(header_block) else {
        return Envelope::default();
    };
    let in_reply_to = match msg.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(format!("<{t}>")),
        mail_parser::HeaderValue::TextList(list) if !list.is_empty() => Some(
            list.iter()
                .map(|t| format!("<{t}>"))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    };
    Envelope {
        date: msg.date().and_then(to_chrono),
        subject: msg.subject().map(str::to_string),
        from: addresses(msg.from()),
        sender: addresses(msg.sender()),
        reply_to: addresses(msg.reply_to()),
        to: addresses(msg.to()),
        cc: addresses(msg.cc()),
        bcc: addresses(msg.bcc()),
        message_id: msg.message_id().map(|id| format!("<{id}>")),
        in_reply_to,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_tetes_replies() {
        let h = parse_header_block(b"Subject: un\r\n  long sujet\r\nX-Vide:\r\n: sans nom\r\nsans deux-points\r\nTo: a@b.c,\r\n\tc@d.e\r\n\r\n");
        assert_eq!(h.len(), 3);
        assert_eq!(
            h[0],
            RawHeader {
                name: "Subject".into(),
                value: "un long sujet".into()
            }
        );
        assert_eq!(h[1].value, "");
        assert_eq!(h[2].value, "a@b.c, c@d.e");
        assert_eq!(header_values(&h, "SUBJECT"), vec!["un long sujet"]);
    }

    #[test]
    fn mots_encodes_adjacents() {
        assert_eq!(decode_words("=?UTF-8?Q?a?= =?UTF-8?Q?b?="), "ab");
        assert_eq!(
            decode_words("=?UTF-8?Q?a?=  =?UTF-8?Q?b?= \r\n =?UTF-8?B?Yw==?="),
            "abc"
        );
        assert_eq!(
            decode_words("x =?ISO-8859-1?Q?caf=E9_cr=E8me?= y"),
            "x café crème y"
        );
        assert_eq!(decode_words("=?utf-8*fr?B?w6l0w6k?="), "été");
    }

    #[test]
    fn identifiants_et_url() {
        assert_eq!(
            parse_message_ids(Some("<a@b> <c@d>")),
            Some(vec!["a@b".into(), "c@d".into()])
        );
        assert_eq!(parse_message_ids(Some("a@b nu")), Some(vec!["a@b".into()]));
        assert_eq!(parse_message_ids(Some("rien")), None);
        assert_eq!(parse_message_ids(None), None);
        assert_eq!(
            parse_urls("<mailto:x@y>, <https://e.x/u\r\n nsub>"),
            Some(vec!["mailto:x@y".into(), "https://e.x/unsub".into()])
        );
        assert_eq!(parse_urls("aucune"), None);
    }

    #[test]
    fn adresses_citees() {
        let a = parse_addresses(r#""Dupont, Jean" <jean@ex.fr>, marie@ex.fr, =?UTF-8?Q?L=C3=A9a?= <lea@ex.fr>, "<x@y>""#).unwrap();
        assert_eq!(
            a[0],
            Address {
                name: Some("Dupont, Jean".into()),
                email: "jean@ex.fr".into()
            }
        );
        assert_eq!(
            a[1],
            Address {
                name: None,
                email: "marie@ex.fr".into()
            }
        );
        assert_eq!(
            a[2],
            Address {
                name: Some("Léa".into()),
                email: "lea@ex.fr".into()
            }
        );
        assert_eq!(a.len(), 4);
        assert_eq!(parse_addresses(" , "), None);
    }

    #[test]
    fn enveloppe_latin1() {
        let block = b"Date: Tue, 3 Nov 2026 10:20:30 +0100\r\nSubject: =?ISO-8859-1?Q?R=E9union_d=27=E9quipe?=\r\nFrom: =?ISO-8859-1?Q?Ren=E9?= <rene@ex.fr>\r\nTo: a@ex.fr, Groupe: b@ex.fr, c@ex.fr;\r\nMessage-ID: <id1@ex.fr>\r\nIn-Reply-To: <p1@ex.fr>\r\n\r\n";
        let e = envelope(block);
        assert_eq!(e.subject.as_deref(), Some("Réunion d'équipe"));
        assert_eq!(
            e.from,
            vec![Address {
                name: Some("René".into()),
                email: "rene@ex.fr".into()
            }]
        );
        assert_eq!(
            e.to.iter().map(|a| a.email.as_str()).collect::<Vec<_>>(),
            vec!["a@ex.fr", "b@ex.fr", "c@ex.fr"]
        );
        assert_eq!(e.message_id.as_deref(), Some("<id1@ex.fr>"));
        assert_eq!(e.in_reply_to.as_deref(), Some("<p1@ex.fr>"));
        assert_eq!(e.date.unwrap().to_rfc3339(), "2026-11-03T10:20:30+01:00");
        assert!(e.cc.is_empty());
    }

    #[test]
    fn dates() {
        assert_eq!(
            parse_date("Wed, 4 Nov 2026 08:00:00 -0500")
                .unwrap()
                .to_rfc3339(),
            "2026-11-04T08:00:00-05:00"
        );
        assert_eq!(parse_date("pas une date"), None);
    }
}
