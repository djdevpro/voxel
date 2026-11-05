//! Noms de dossiers IMAP et drapeaux tels qu'imapflow les traite en silence : UTF-7 modifié (RFC 3501 §5.1.3), espace de noms personnel, INBOX, mise en forme et filtre des drapeaux. Fonctions pures, sans réseau.

use base64::Engine;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};

use crate::session::FlagOp;

/// Base64 de l'UTF-7 modifié : alphabet `A–Z a–z 0–9 + ,`, sans `=`.
const MUTF7: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::IMAP_MUTF7,
    GeneralPurposeConfig::new().with_encode_padding(false),
);
/// Drapeaux système ramenés à leur casse canonique.
const SYSTEM_FLAGS: [&str; 5] = ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Namespace {
    pub prefix: String,
    pub delimiter: Option<String>,
}

impl Default for Namespace {
    fn default() -> Self {
        Namespace {
            prefix: String::new(),
            delimiter: Some(".".into()),
        }
    }
}

fn printable(c: char) -> bool {
    ('\u{20}'..='\u{7e}').contains(&c)
}

pub fn encode_utf7(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut run: Vec<u16> = Vec::new();
    let flush = |run: &mut Vec<u16>, out: &mut String| {
        if run.is_empty() {
            return;
        }
        let bytes: Vec<u8> = run.iter().flat_map(|u| u.to_be_bytes()).collect();
        out.push('&');
        out.push_str(&MUTF7.encode(bytes));
        out.push('-');
        run.clear();
    };
    for c in name.chars() {
        if printable(c) {
            flush(&mut run, &mut out);
            if c == '&' {
                out.push_str("&-");
            } else {
                out.push(c);
            }
        } else {
            let mut buf = [0u16; 2];
            run.extend_from_slice(c.encode_utf16(&mut buf));
        }
    }
    flush(&mut run, &mut out);
    out
}

fn sextet(c: char) -> Option<u32> {
    match c {
        'A'..='Z' => Some(c as u32 - 'A' as u32),
        'a'..='z' => Some(c as u32 - 'a' as u32 + 26),
        '0'..='9' => Some(c as u32 - '0' as u32 + 52),
        '+' => Some(62),
        ',' => Some(63),
        _ => None,
    }
}

pub fn decode_utf7(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '&' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        let mut units: Vec<u16> = Vec::new();
        let (mut acc, mut bits, mut len) = (0u32, 0u32, 0usize);
        while let Some(v) = chars.get(i).and_then(|c| sextet(*c)) {
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 16 {
                bits -= 16;
                units.push((acc >> bits) as u16);
                acc &= (1 << bits) - 1;
            }
            len += 1;
            i += 1;
        }
        let dash = chars.get(i) == Some(&'-');
        if dash {
            i += 1;
        }
        if len == 0 {
            if dash {
                out.push('&');
            }
        } else {
            out.push_str(&String::from_utf16_lossy(&units));
        }
    }
    out
}

pub fn normalize_path(ns: &Namespace, path: &str, skip_namespace: bool) -> String {
    if path.eq_ignore_ascii_case("INBOX") {
        return "INBOX".into();
    }
    if !skip_namespace && !ns.prefix.is_empty() && !path.starts_with(&ns.prefix) {
        return format!("{}{path}", ns.prefix);
    }
    path.to_string()
}

/// Chemin tel qu'il part sur le fil : préfixe ajouté, puis UTF-7 modifié (sauf noms UTF-8).
pub fn wire_path(ns: &Namespace, utf8_names: bool, path: &str) -> String {
    let p = normalize_path(ns, path, false);
    if utf8_names { p } else { encode_utf7(&p) }
}

/// Chemin d'une entrée listée : décodé, INBOX, préfixe, délimiteur de tête retiré.
pub fn listed_path(ns: &Namespace, utf8_names: bool, raw: &str, delimiter: Option<&str>) -> String {
    let decoded = if utf8_names {
        raw.to_string()
    } else {
        decode_utf7(raw)
    };
    let p = normalize_path(ns, &decoded, false);
    match delimiter.filter(|d| !d.is_empty()) {
        Some(d) => p.strip_prefix(d).map(str::to_string).unwrap_or(p),
        None => p,
    }
}

pub fn format_flag(flag: &str) -> Option<String> {
    if flag.eq_ignore_ascii_case("\\Recent") {
        return None;
    }
    let bare = flag.strip_prefix('\\').unwrap_or(flag);
    if bare.is_empty()
        || bare
            .chars()
            .any(|c| c == ' ' || c.is_control() || "(){%*\"\\]".contains(c))
    {
        return None;
    }
    Some(
        SYSTEM_FLAGS
            .iter()
            .find(|s| s.eq_ignore_ascii_case(flag))
            .map(|s| s.to_string())
            .unwrap_or_else(|| flag.to_string()),
    )
}

/// Drapeaux à envoyer dans `UID STORE` ; `None` : aucune commande.
pub fn store_flags(
    op: FlagOp,
    flags: &[String],
    permanent: Option<&[String]>,
) -> Option<Vec<String>> {
    let formatted: Vec<String> = flags.iter().filter_map(|f| format_flag(f)).collect();
    let kept: Vec<String> = match op {
        FlagOp::Remove => formatted,
        FlagOp::Add | FlagOp::Replace => formatted
            .into_iter()
            .filter(|f| permanent.is_none_or(|p| p.iter().any(|x| x == "\\*" || x == f)))
            .collect(),
    };
    if kept.is_empty() {
        return if matches!(op, FlagOp::Replace) && flags.is_empty() {
            Some(Vec::new())
        } else {
            None
        };
    }
    Some(kept)
}

/// Chaîne IMAP citée en tête de `s` (`\"` et `\\` échappés) : (valeur, reste).
fn take_quoted(s: &[u8]) -> Option<(String, &[u8])> {
    let body = s.strip_prefix(b"\"")?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        match body[i] {
            b'\\' => {
                out.push(*body.get(i + 1)?);
                i += 2;
            }
            b'"' => return Some((String::from_utf8_lossy(&out).into_owned(), &body[i + 1..])),
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// Premier couple du groupe personnel d'une réponse `* NAMESPACE` (extensions ignorées, préfixe non
/// décodé) ; le délimiteur est ajouté à la fin d'un préfixe non vide. `None` : groupe NIL, littéral
/// ou réponse illisible.
pub fn parse_namespace(raw: &[u8]) -> Option<Namespace> {
    let line = raw.split(|b| *b == b'\n').find_map(|l| {
        l.get(..12)
            .filter(|h| h.eq_ignore_ascii_case(b"* NAMESPACE "))
            .map(|_| &l[12..])
    })?;
    let rest = line.strip_prefix(b"((")?;
    let (mut prefix, rest) = take_quoted(rest)?;
    let rest = rest.strip_prefix(b" ")?;
    let delimiter = if rest.len() >= 3 && rest[..3].eq_ignore_ascii_case(b"NIL") {
        None
    } else {
        Some(take_quoted(rest)?.0)
    };
    if let Some(d) = delimiter.as_deref().filter(|d| !d.is_empty())
        && !prefix.is_empty()
        && !prefix.ends_with(d)
    {
        prefix.push_str(d);
    }
    Some(Namespace { prefix, delimiter })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAIRS: [(&str, &str); 10] = [
        ("Envoyés", "Envoy&AOk-s"),
        ("Tom & Jerry", "Tom &- Jerry"),
        ("A&B", "A&-B"),
        ("é&ü", "&AOk-&-&APw-"),
        ("Éléments envoyés", "&AMk-l&AOk-ments envoy&AOk-s"),
        ("Courrier indésirable", "Courrier ind&AOk-sirable"),
        ("~peter/mail/台北/日本語", "~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
        ("📁 Projets", "&2D3cwQ- Projets"),
        ("INBOX.Sent", "INBOX.Sent"),
        ("Voxel é & ü", "Voxel &AOk- &- &APw-"),
    ];

    #[test]
    fn reponse_namespace() {
        let ns = |body: &str| {
            parse_namespace(format!("* NAMESPACE {body}\r\nV1 OK NAMESPACE done\r\n").as_bytes())
        };
        let n = |p: &str, d: Option<&str>| {
            Some(Namespace {
                prefix: p.into(),
                delimiter: d.map(str::to_string),
            })
        };
        assert_eq!(ns(r#"(("" "/")) NIL NIL"#), n("", Some("/")));
        assert_eq!(
            ns(r##"(("INBOX." ".")) NIL (("#shared." "."))"##),
            n("INBOX.", Some("."))
        );
        assert_eq!(ns(r#"(("INBOX" ".")) NIL NIL"#), n("INBOX.", Some(".")));
        assert_eq!(
            ns(r#"(("" "/" "X-PARAM" ("A" "B"))) NIL NIL"#),
            n("", Some("/"))
        );
        assert_eq!(ns(r#"(("" NIL)) NIL NIL"#), n("", None));
        assert_eq!(ns(r#"(("" "\\")) NIL NIL"#), n("", Some("\\")));
        assert_eq!(ns(r##"NIL NIL (("#public/" "/"))"##), None);
        assert_eq!(parse_namespace(b"* OK rien\r\nV1 NO non\r\n"), None);
    }

    #[test]
    fn utf7_aller_retour() {
        for (plain, wire) in PAIRS {
            assert_eq!(encode_utf7(plain), wire, "{plain}");
            assert_eq!(decode_utf7(wire), plain, "{wire}");
        }
    }

    #[test]
    fn utf7_decodage_tolerant() {
        for (wire, plain) in [
            ("&-", "&"),
            ("&AOkA6Q-", "éé"),
            ("&Jjo", "☺"),
            ("&AOk", "é"),
            ("&AOk.x", "é.x"),
            ("A& B", "A B"),
            ("a&&-b", "a&b"),
            ("&2D0-", "\u{FFFD}"),
        ] {
            assert_eq!(decode_utf7(wire), plain, "{wire}");
        }
    }

    #[test]
    fn chemins() {
        let ns = Namespace {
            prefix: "INBOX.".into(),
            delimiter: Some(".".into()),
        };
        assert_eq!(normalize_path(&ns, "Projets", false), "INBOX.Projets");
        assert_eq!(normalize_path(&ns, "Projets", true), "Projets");
        assert_eq!(normalize_path(&ns, "INBOX.Projets", false), "INBOX.Projets");
        assert_eq!(normalize_path(&ns, "inbox", false), "INBOX");
        assert_eq!(normalize_path(&ns, "Inbox", false), "INBOX");
        let empty = Namespace {
            prefix: String::new(),
            delimiter: Some("/".into()),
        };
        assert_eq!(normalize_path(&empty, "Projets", false), "Projets");
        assert_eq!(normalize_path(&empty, "inbox", false), "INBOX");
        assert_eq!(wire_path(&ns, false, "Envoyés"), "INBOX.Envoy&AOk-s");
        assert_eq!(wire_path(&ns, true, "Envoyés"), "INBOX.Envoyés");
        assert_eq!(
            listed_path(&ns, false, "INBOX.Envoy&AOk-s", Some(".")),
            "INBOX.Envoyés"
        );
        assert_eq!(listed_path(&empty, false, "/Sent", Some("/")), "Sent");
        assert_eq!(listed_path(&empty, false, "inbox", Some("/")), "INBOX");
        assert_eq!(
            Namespace::default(),
            Namespace {
                prefix: String::new(),
                delimiter: Some(".".into())
            }
        );
    }

    #[test]
    fn drapeaux() {
        assert_eq!(format_flag("\\seen").as_deref(), Some("\\Seen"));
        assert_eq!(format_flag("\\RECENT"), None);
        assert_eq!(format_flag("$Forwarded").as_deref(), Some("$Forwarded"));
        assert_eq!(format_flag("bad flag"), None);
        assert_eq!(format_flag("\\"), None);
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let perm = s(&["\\Seen", "\\Flagged"]);
        assert_eq!(
            store_flags(FlagOp::Add, &s(&["\\Seen", "$Forwarded"]), Some(&perm)),
            Some(s(&["\\Seen"]))
        );
        assert_eq!(
            store_flags(FlagOp::Add, &s(&["$Forwarded"]), Some(&perm)),
            None
        );
        assert_eq!(
            store_flags(FlagOp::Remove, &s(&["$Forwarded"]), Some(&perm)),
            Some(s(&["$Forwarded"]))
        );
        let star = s(&["\\*"]);
        assert_eq!(
            store_flags(FlagOp::Add, &s(&["$Forwarded", "\\seen"]), Some(&star)),
            Some(s(&["$Forwarded", "\\Seen"]))
        );
        assert_eq!(
            store_flags(FlagOp::Replace, &s(&["$Forwarded"]), None),
            Some(s(&["$Forwarded"]))
        );
        assert_eq!(store_flags(FlagOp::Replace, &[], Some(&perm)), Some(vec![]));
    }
}
