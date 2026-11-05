//! Structure MIME d'un message : conversion de la BODYSTRUCTURE IMAP en arbre `Node` (ce qu'imapflow
//! fournissait : types en minuscules, paramètres décodés, numéros de parties IMAP), puis en parties
//! (`BodyPart`) et répartition texte / HTML / pièces jointes selon RFC 8621 §4.1.4. Port de `mime.ts` ;
//! le JSON JMAP est construit par la façade.

use std::borrow::Cow;

use async_imap::imap_proto::{BodyContentCommon, BodyStructure, ContentEncoding};

use crate::decode::decode_charset;
use crate::headers::decode_words;

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub content_type: String,
    pub params: Vec<(String, String)>,
    pub id: Option<String>,
    pub encoding: String,
    pub size: u32,
    pub disposition: Option<String>,
    pub disposition_params: Vec<(String, String)>,
    pub language: Option<Vec<String>>,
    pub location: Option<String>,
    pub part: Option<String>,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BodyPart {
    pub part_id: Option<String>,
    pub blob_id: Option<String>,
    pub size: u64,
    pub name: Option<String>,
    pub content_type: String,
    pub charset: Option<String>,
    pub disposition: Option<String>,
    pub cid: Option<String>,
    pub language: Option<Vec<String>>,
    pub location: Option<String>,
    pub encoding: Option<String>,
    pub sub_parts: Option<Vec<BodyPart>>,
}

pub struct SplitBody {
    pub text_body: Vec<BodyPart>,
    pub html_body: Vec<BodyPart>,
    pub attachments: Vec<BodyPart>,
}

type RawParams<'a> = Option<Vec<(Cow<'a, str>, Cow<'a, str>)>>;

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = b
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Paramètres : clés en minuscules, mots RFC 2047 décodés, continuations RFC 2231 réunies (`name*0*=`…).
fn decode_params(raw: &RawParams<'_>) -> Vec<(String, String)> {
    struct Acc {
        key: String,
        plain: Option<String>,
        segments: Vec<(u32, bool, String)>,
    }
    let mut accs: Vec<Acc> = Vec::new();
    for (k, v) in raw.iter().flatten() {
        let k = k.to_lowercase();
        let (base, segment) = match k.find('*') {
            None => (k.clone(), None),
            Some(star) => {
                let base = k[..star].to_string();
                let rest = &k[star + 1..];
                let extended = rest.ends_with('*') || rest.is_empty();
                let index = rest.trim_end_matches('*').parse::<u32>().unwrap_or(0);
                (base, Some((index, extended)))
            }
        };
        let pos = match accs.iter().position(|a| a.key == base) {
            Some(p) => p,
            None => {
                accs.push(Acc {
                    key: base,
                    plain: None,
                    segments: Vec::new(),
                });
                accs.len() - 1
            }
        };
        match segment {
            None => accs[pos].plain = Some(v.to_string()),
            Some((index, extended)) => accs[pos].segments.push((index, extended, v.to_string())),
        }
    }
    accs.into_iter()
        .map(|mut a| {
            if a.segments.is_empty() {
                return (a.key, decode_words(&a.plain.unwrap_or_default()));
            }
            a.segments.sort_by_key(|s| s.0);
            let mut charset: Option<String> = None;
            let mut bytes = Vec::new();
            for (i, (_, extended, value)) in a.segments.iter().enumerate() {
                if !extended {
                    bytes.extend_from_slice(value.as_bytes());
                    continue;
                }
                let mut text = value.as_str();
                if i == 0 {
                    let mut it = text.splitn(3, '\'');
                    if let (Some(cs), Some(_lang), Some(rest)) = (it.next(), it.next(), it.next()) {
                        if !cs.is_empty() {
                            charset = Some(cs.to_string());
                        }
                        text = rest;
                    }
                }
                bytes.extend(percent_decode(text));
            }
            (a.key, decode_charset(&bytes, charset.as_deref()))
        })
        .collect()
}

fn encoding_name(e: &ContentEncoding<'_>) -> String {
    match e {
        ContentEncoding::SevenBit => "7bit".into(),
        ContentEncoding::EightBit => "8bit".into(),
        ContentEncoding::Binary => "binary".into(),
        ContentEncoding::Base64 => "base64".into(),
        ContentEncoding::QuotedPrintable => "quoted-printable".into(),
        ContentEncoding::Other(s) => s.to_lowercase(),
    }
}

fn common_fields(node: &mut Node, common: &BodyContentCommon<'_>) {
    node.content_type = format!("{}/{}", common.ty.ty, common.ty.subtype).to_lowercase();
    node.params = decode_params(&common.ty.params);
    if let Some(d) = &common.disposition {
        node.disposition = Some(d.ty.to_lowercase());
        node.disposition_params = decode_params(&d.params);
    }
    node.language = common
        .language
        .as_ref()
        .map(|l| l.iter().map(|x| x.to_lowercase()).collect());
    node.location = common.location.as_ref().map(|l| l.to_string());
}

fn convert(structure: &BodyStructure<'_>, part: Option<String>) -> Node {
    let mut node = Node {
        part: part.clone(),
        ..Node::default()
    };
    match structure {
        BodyStructure::Multipart { common, bodies, .. } => {
            common_fields(&mut node, common);
            node.children = bodies
                .iter()
                .enumerate()
                .map(|(i, b)| {
                    convert(
                        b,
                        Some(match &part {
                            Some(p) => format!("{p}.{}", i + 1),
                            None => (i + 1).to_string(),
                        }),
                    )
                })
                .collect();
        }
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        | BodyStructure::Message { common, other, .. } => {
            common_fields(&mut node, common);
            node.id = other.id.as_ref().map(|s| s.to_string());
            node.encoding = encoding_name(&other.transfer_encoding);
            node.size = other.octets;
        }
    }
    node
}

/// Arbre `Node` d'une BODYSTRUCTURE, parties numérotées comme IMAP (racine sans numéro).
pub fn node_from_imap(structure: &async_imap::imap_proto::BodyStructure<'_>) -> Node {
    convert(structure, None)
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn decoded_size(n: &Node) -> u64 {
    let size = n.size as u64;
    if n.encoding.to_lowercase() == "base64" {
        size * 3 / 4
    } else {
        size
    }
}

/// Convertit l'arbre `Node` en arbre de parties (blobId = `<emailId>.<partId>`).
pub fn structure_to_part(node: &Node, email_id: &str, is_root: bool) -> BodyPart {
    let content_type = if node.content_type.is_empty() {
        "text/plain".to_string()
    } else {
        node.content_type.to_lowercase()
    };
    let multipart = content_type.starts_with("multipart/");
    let part_id = if multipart {
        None
    } else {
        match node.part.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => Some(p.to_string()),
            None if is_root => Some("1".to_string()),
            None => None,
        }
    };
    let raw_name =
        param(&node.disposition_params, "filename").or_else(|| param(&node.params, "name"));
    let name = raw_name.filter(|n| !n.is_empty()).map(decode_words);
    let charset = match param(&node.params, "charset") {
        Some(c) => Some(c.to_string()),
        None if content_type.starts_with("text/") => Some("us-ascii".to_string()),
        None => None,
    };
    BodyPart {
        blob_id: part_id.as_ref().map(|p| format!("{email_id}.{p}")),
        part_id,
        size: if multipart { 0 } else { decoded_size(node) },
        name,
        charset,
        disposition: node
            .disposition
            .as_ref()
            .filter(|d| !d.is_empty())
            .map(|d| d.to_lowercase()),
        cid: node.id.as_ref().filter(|i| !i.is_empty()).map(|i| {
            let i = i.strip_prefix('<').unwrap_or(i);
            i.strip_suffix('>').unwrap_or(i).to_string()
        }),
        language: node.language.clone(),
        location: node.location.clone(),
        encoding: if node.encoding.is_empty() {
            None
        } else {
            Some(node.encoding.clone())
        },
        sub_parts: if multipart {
            Some(
                node.children
                    .iter()
                    .map(|c| structure_to_part(c, email_id, false))
                    .collect(),
            )
        } else {
            None
        },
        content_type,
    }
}

fn is_inline_media(t: &str) -> bool {
    t.starts_with("image/") || t.starts_with("audio/") || t.starts_with("video/")
}

fn parse(
    parts: &[BodyPart],
    multipart_type: &str,
    in_alternative: bool,
    mut html_on: bool,
    mut text_on: bool,
    out: &mut SplitBody,
) {
    let text_length: i64 = if text_on {
        out.text_body.len() as i64
    } else {
        -1
    };
    let html_length: i64 = if html_on {
        out.html_body.len() as i64
    } else {
        -1
    };
    for (i, part) in parts.iter().enumerate() {
        let t = part.content_type.as_str();
        let is_multipart = t.starts_with("multipart/");
        let is_inline = part.disposition.as_deref() != Some("attachment")
            && (t == "text/plain" || t == "text/html" || is_inline_media(t))
            && (i == 0
                || (multipart_type != "related" && (is_inline_media(t) || part.name.is_none())));
        if is_multipart {
            let sub = t.split('/').nth(1).unwrap_or("mixed");
            parse(
                part.sub_parts.as_deref().unwrap_or(&[]),
                sub,
                in_alternative || sub == "alternative",
                html_on,
                text_on,
                out,
            );
        } else if is_inline {
            if multipart_type == "alternative" {
                if t == "text/plain" {
                    if text_on {
                        out.text_body.push(part.clone());
                    }
                } else if t == "text/html" {
                    if html_on {
                        out.html_body.push(part.clone());
                    }
                } else {
                    out.attachments.push(part.clone());
                }
                continue;
            } else if in_alternative {
                if t == "text/plain" {
                    html_on = false;
                }
                if t == "text/html" {
                    text_on = false;
                }
            }
            if text_on {
                out.text_body.push(part.clone());
            }
            if html_on {
                out.html_body.push(part.clone());
            }
            if (!text_on || !html_on) && is_inline_media(t) {
                out.attachments.push(part.clone());
            }
        } else {
            out.attachments.push(part.clone());
        }
    }
    if multipart_type == "alternative" && text_on && html_on {
        let (tl, hl) = (out.text_body.len() as i64, out.html_body.len() as i64);
        if text_length == tl && html_length != hl {
            for i in html_length.max(0) as usize..out.html_body.len() {
                let p = out.html_body[i].clone();
                out.text_body.push(p);
            }
        }
        if html_length == out.html_body.len() as i64 && text_length != tl {
            for i in text_length.max(0) as usize..out.text_body.len() {
                let p = out.text_body[i].clone();
                out.html_body.push(p);
            }
        }
    }
}

/// Algorithme RFC 8621 §4.1.4 : textBody, htmlBody, attachments.
pub fn split_body(root: &BodyPart) -> SplitBody {
    let mut out = SplitBody {
        text_body: Vec::new(),
        html_body: Vec::new(),
        attachments: Vec::new(),
    };
    parse(
        std::slice::from_ref(root),
        "mixed",
        false,
        true,
        true,
        &mut out,
    );
    out
}

pub fn has_real_attachment(attachments: &[BodyPart]) -> bool {
    attachments.iter().any(|p| {
        p.disposition.as_deref() == Some("attachment")
            || (p.name.is_some() && p.cid.is_none())
            || (!p.content_type.starts_with("image/") && p.cid.is_none())
    })
}

pub fn find_part<'a>(root: &'a BodyPart, part_id: &str) -> Option<&'a BodyPart> {
    if root.part_id.as_deref() == Some(part_id) {
        return Some(root);
    }
    root.sub_parts
        .iter()
        .flatten()
        .find_map(|s| find_part(s, part_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(t: &str, part: &str, size: u32, enc: &str) -> Node {
        Node {
            content_type: t.into(),
            encoding: enc.into(),
            size,
            part: Some(part.into()),
            ..Node::default()
        }
    }
    fn multi(t: &str, part: Option<&str>, children: Vec<Node>) -> Node {
        Node {
            content_type: t.into(),
            part: part.map(str::to_string),
            children,
            ..Node::default()
        }
    }
    fn ids(parts: &[BodyPart]) -> Vec<&str> {
        parts
            .iter()
            .map(|p| p.part_id.as_deref().unwrap_or("-"))
            .collect()
    }

    #[test]
    fn texte_seul() {
        let node = Node {
            content_type: "text/plain".into(),
            params: vec![("charset".into(), "utf-8".into())],
            encoding: "7bit".into(),
            size: 42,
            ..Node::default()
        };
        let root = structure_to_part(&node, "E1", true);
        assert_eq!(root.part_id.as_deref(), Some("1"));
        assert_eq!(root.blob_id.as_deref(), Some("E1.1"));
        assert_eq!(root.charset.as_deref(), Some("utf-8"));
        assert_eq!(root.size, 42);
        assert_eq!(root.encoding.as_deref(), Some("7bit"));
        let s = split_body(&root);
        assert_eq!(ids(&s.text_body), vec!["1"]);
        assert_eq!(ids(&s.html_body), vec!["1"]);
        assert!(s.attachments.is_empty());
        assert!(!has_real_attachment(&s.attachments));
    }

    #[test]
    fn alternative() {
        let node = multi(
            "multipart/alternative",
            None,
            vec![
                leaf("text/plain", "1", 10, "7bit"),
                leaf("text/html", "2", 80, "base64"),
            ],
        );
        let root = structure_to_part(&node, "E", true);
        assert_eq!(root.part_id, None);
        assert_eq!(root.size, 0);
        assert_eq!(root.encoding, None);
        assert_eq!(root.sub_parts.as_ref().unwrap()[1].size, 60);
        assert_eq!(
            root.sub_parts.as_ref().unwrap()[0].charset.as_deref(),
            Some("us-ascii")
        );
        let s = split_body(&root);
        assert_eq!(ids(&s.text_body), vec!["1"]);
        assert_eq!(ids(&s.html_body), vec!["2"]);
        assert!(s.attachments.is_empty());
    }

    #[test]
    fn mixed_related_cid() {
        let mut img = leaf("image/png", "1.2.2", 400, "base64");
        img.id = Some("<logo@x>".into());
        img.disposition = Some("inline".into());
        img.params = vec![("name".into(), "logo.png".into())];
        let mut pdf = leaf("application/pdf", "2", 800, "base64");
        pdf.disposition = Some("attachment".into());
        pdf.disposition_params =
            vec![("filename".into(), "=?UTF-8?Q?r=C3=A9sum=C3=A9.pdf?=".into())];
        let node = multi(
            "multipart/mixed",
            None,
            vec![
                multi(
                    "multipart/related",
                    Some("1"),
                    vec![
                        multi(
                            "multipart/alternative",
                            Some("1.1"),
                            vec![
                                leaf("text/plain", "1.1.1", 10, "7bit"),
                                leaf("text/html", "1.1.2", 20, "7bit"),
                            ],
                        ),
                        img,
                    ],
                ),
                pdf,
            ],
        );
        let root = structure_to_part(&node, "E", true);
        let s = split_body(&root);
        assert_eq!(ids(&s.text_body), vec!["1.1.1"]);
        assert_eq!(ids(&s.html_body), vec!["1.1.2"]);
        assert_eq!(ids(&s.attachments), vec!["1.2.2", "2"]);
        let logo = find_part(&root, "1.2.2").unwrap();
        assert_eq!(logo.cid.as_deref(), Some("logo@x"));
        assert_eq!(logo.size, 300);
        assert_eq!(logo.name.as_deref(), Some("logo.png"));
        assert_eq!(
            find_part(&root, "2").unwrap().name.as_deref(),
            Some("résumé.pdf")
        );
        assert!(has_real_attachment(&s.attachments));
        assert!(!has_real_attachment(&s.attachments[..1]));
        assert!(find_part(&root, "9").is_none());
    }

    #[test]
    fn rfc822_joint() {
        let mut inner = leaf("message/rfc822", "2", 1200, "7bit");
        inner.params = vec![("name".into(), "fwd.eml".into())];
        let node = multi(
            "multipart/mixed",
            None,
            vec![leaf("text/plain", "1", 30, "quoted-printable"), inner],
        );
        let root = structure_to_part(&node, "E", true);
        let s = split_body(&root);
        assert_eq!(ids(&s.text_body), vec!["1"]);
        assert_eq!(ids(&s.html_body), vec!["1"]);
        assert_eq!(ids(&s.attachments), vec!["2"]);
        assert_eq!(s.attachments[0].sub_parts, None);
        assert_eq!(s.attachments[0].charset, None);
        assert!(has_real_attachment(&s.attachments));
    }

    fn parse_bodystructure(raw: &[u8], check: impl FnOnce(Node)) {
        let (_, resp) = async_imap::imap_proto::Response::parse(raw).unwrap();
        let async_imap::imap_proto::Response::Fetch(_, attrs) = resp else {
            panic!("réponse inattendue")
        };
        let bs = attrs.iter().find_map(|a| match a {
            async_imap::imap_proto::AttributeValue::BodyStructure(b) => Some(b),
            _ => None,
        });
        check(node_from_imap(bs.unwrap()));
    }

    #[test]
    fn numerotation_et_parametres_imap() {
        let raw = b"* 1 FETCH (BODYSTRUCTURE (((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 10 1 NIL NIL NIL NIL)(\"TEXT\" \"HTML\" (\"charset\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 20 1 NIL NIL NIL NIL) \"ALTERNATIVE\" (\"boundary\" \"b2\") NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME*0*\" \"utf-8''r%C3%A9su\" \"NAME*1*\" \"m%C3%A9.pdf\") \"<c1>\" NIL \"BASE64\" 400 NIL (\"ATTACHMENT\" (\"FILENAME\" \"=?UTF-8?Q?r=C3=A9sum=C3=A9.pdf?=\")) (\"FR\") NIL)(\"MESSAGE\" \"RFC822\" NIL NIL NIL \"7BIT\" 300 (NIL \"s\" NIL NIL NIL NIL NIL NIL NIL NIL) (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL) 9 NIL NIL NIL NIL) \"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL NIL))\r\n";
        parse_bodystructure(raw, |n| {
            assert_eq!(n.content_type, "multipart/mixed");
            assert_eq!(n.part, None);
            assert_eq!(n.params, vec![("boundary".to_string(), "b1".to_string())]);
            let alt = &n.children[0];
            assert_eq!(alt.part.as_deref(), Some("1"));
            assert_eq!(alt.children[1].part.as_deref(), Some("1.2"));
            assert_eq!(alt.children[1].encoding, "quoted-printable");
            assert_eq!(
                alt.children[0].params,
                vec![("charset".to_string(), "UTF-8".to_string())]
            );
            let pdf = &n.children[1];
            assert_eq!(pdf.part.as_deref(), Some("2"));
            assert_eq!(
                pdf.params,
                vec![("name".to_string(), "résumé.pdf".to_string())]
            );
            assert_eq!(pdf.disposition.as_deref(), Some("attachment"));
            assert_eq!(
                pdf.disposition_params,
                vec![("filename".to_string(), "résumé.pdf".to_string())]
            );
            assert_eq!(pdf.language, Some(vec!["fr".to_string()]));
            assert_eq!(pdf.id.as_deref(), Some("<c1>"));
            let msg = &n.children[2];
            assert_eq!(msg.content_type, "message/rfc822");
            assert_eq!(msg.part.as_deref(), Some("3"));
            assert!(msg.children.is_empty());
            assert_eq!(msg.size, 300);
        });
        parse_bodystructure(b"* 2 FETCH (BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"8BIT\" 7 1 NIL NIL NIL NIL))\r\n", |n| {
            assert_eq!(n.part, None);
            assert_eq!(structure_to_part(&n, "E", true).part_id.as_deref(), Some("1"));
        });
    }
}
