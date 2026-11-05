//! En-têtes des pièces jointes servies par `/imap/download` (port de `safeMimeType` et `blobHeaders`, `routes/imap.ts`) :
//! le type demandé n'est jamais reflété tel quel, et tout blob part sous une CSP `sandbox`.

use std::sync::LazyLock;

use regex::Regex;

/// Types affichables dans la page quand l'interface demande `inline=1` ; tout le reste part en pièce jointe.
const INLINE_TYPES: [&str; 8] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "application/pdf",
    "text/plain",
];

/// Un seul `type/sous-type`, suivi de paramètres facultatifs.
static MIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([a-z0-9][a-z0-9!#$&^_.+-]{0,126})/([a-z0-9][a-z0-9!#$&^_.+-]{0,126})\s*(?:;\s*(.*))?$",
    )
    .expect("expression MIME")
});

/// Jeu de caractères d'un type `text/*`.
static CHARSET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^charset="?([a-z0-9._-]{1,40})"?\s*$"#).expect("expression charset")
});

/// Type MIME sûr : un seul type `type/sous-type` (charset seulement pour text/*), sinon application/octet-stream.
pub fn safe_mime_type(raw: Option<&str>) -> String {
    let value = raw.unwrap_or("").trim().to_lowercase();
    let Some(m) = MIME_RE.captures(&value) else {
        return "application/octet-stream".to_string();
    };
    let base = format!("{}/{}", &m[1], &m[2]);
    if &m[1] == "text"
        && let Some(params) = m.get(3).map(|p| p.as_str()).filter(|p| !p.is_empty())
        && let Some(cs) = CHARSET_RE.captures(params)
    {
        return format!("{base}; charset={}", &cs[1]);
    }
    base
}

pub fn blob_headers(content_type: &str, name: &str, inline: bool) -> Vec<(String, String)> {
    let content_type = safe_mime_type(Some(content_type));
    let base = content_type.split(';').next().unwrap_or("");
    let inline = inline && INLINE_TYPES.contains(&base);
    // Comme la version JS, qui remplace chaque unité UTF-16 hors ASCII imprimable.
    let safe_ascii: String = name
        .chars()
        .flat_map(|c| {
            let keep = matches!(c, '\x20'..='\x7e') && c != '"' && c != '\\';
            let n = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, n)
        })
        .collect();
    vec![
        ("Content-Type".to_string(), content_type.clone()),
        (
            "Content-Disposition".to_string(),
            format!(
                "{}; filename=\"{safe_ascii}\"; filename*=UTF-8''{}",
                if inline { "inline" } else { "attachment" },
                encode_uri_component(name)
            ),
        ),
        ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
        ("Cache-Control".to_string(), "private, no-store".to_string()),
        (
            "Content-Security-Policy".to_string(),
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox".to_string(),
        ),
    ]
}

/// `encodeURIComponent` de JavaScript.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent` tolérant, comme le routeur de Hono : une séquence illisible laisse le texte tel quel.
pub(crate) fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let Some(v) = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            else {
                return text.to_string();
            };
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}
