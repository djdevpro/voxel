//! Décodage du contenu des parties : jeu de caractères, encodage de transfert (base64, quoted-printable),
//! et aperçu texte d'un corps. Port de `mime.ts` ; les décodeurs de mail-parser remplacent `TextDecoder`
//! et le convertisseur HTML → texte. Rien ici ne panique sur une entrée mal formée : un message reçu
//! peut contenir n'importe quoi.

/// Longueur au-delà de laquelle l'aperçu est coupé (en caractères).
const PREVIEW_MAX: usize = 256;

/// Texte d'une partie selon son jeu de caractères (UTF-8 avec remplacement si l'étiquette est inconnue).
pub fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    let cs = charset.unwrap_or("utf-8").trim().to_lowercase();
    let cs = cs.strip_prefix('"').unwrap_or(&cs);
    let cs = cs.strip_suffix('"').unwrap_or(cs);
    let label = if cs == "us-ascii" || cs == "ascii" {
        "utf-8"
    } else {
        cs
    };
    let text = match mail_parser::decoders::charsets::map::charset_decoder(label.as_bytes()) {
        Some(decoder) if label != "utf-8" && label != "utf8" => decoder(bytes),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    };
    match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    }
}

/// Quoted-printable (`header` : forme des mots encodés, où `_` vaut une espace).
pub(crate) fn decode_quoted_printable(input: &[u8], header: bool) -> Vec<u8> {
    let src: Vec<u8> = if header {
        input
            .iter()
            .map(|&b| if b == b'_' { b' ' } else { b })
            .collect()
    } else {
        strip_soft_breaks(input)
    };
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        let ch = src[i];
        if ch == b'='
            && let (Some(h), Some(l)) = (
                src.get(i + 1).and_then(|c| hex(*c)),
                src.get(i + 2).and_then(|c| hex(*c)),
            )
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Retire les sauts de ligne doux `=\r?\n`.
fn strip_soft_breaks(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'=' {
            if input.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            if input.get(i + 1) == Some(&b'\r') && input.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
        }
        out.push(input[i]);
        i += 1;
    }
    out
}

/// Base64 tolérant : caractères hors alphabet retirés ; `partial` coupe au dernier groupe complet.
pub(crate) fn decode_base64(raw: &[u8], partial: bool) -> Vec<u8> {
    let mut s: Vec<u8> = raw
        .iter()
        .copied()
        .filter(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/' || *b == b'=')
        .collect();
    if partial {
        s.truncate(s.len() - s.len() % 4);
    }
    mail_parser::decoders::base64::base64_decode(&s).unwrap_or_default()
}

/// Décode le contenu d'une partie selon son Content-Transfer-Encoding. `partial` : contenu tronqué.
pub fn decode_transfer(raw: &[u8], encoding: Option<&str>, partial: bool) -> Vec<u8> {
    let enc = encoding.unwrap_or("7bit").to_lowercase();
    match enc.as_str() {
        "base64" => decode_base64(raw, partial),
        "quoted-printable" => {
            let mut s = raw;
            if partial {
                // `=` final, éventuellement suivi d'un seul chiffre hexadécimal : séquence coupée
                if s.last() == Some(&b'=') {
                    s = &s[..s.len() - 1];
                } else if s.len() >= 2
                    && s[s.len() - 2] == b'='
                    && s[s.len() - 1].is_ascii_hexdigit()
                {
                    s = &s[..s.len() - 2];
                }
            }
            decode_quoted_printable(s, false)
        }
        _ => raw.to_vec(),
    }
}

/// Aperçu d'un corps : texte (HTML converti), blancs repliés, coupé à 255 caractères + `…` au-delà de 256.
pub fn make_preview(text: &str, is_html: bool) -> String {
    let source = if is_html {
        mail_parser::decoders::html::html_to_text(text)
    } else {
        text.to_string()
    };
    let t = source.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > PREVIEW_MAX {
        let mut cut: String = t.chars().take(PREVIEW_MAX - 1).collect();
        cut.push('…');
        cut
    } else {
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_printable_saut_doux() {
        let raw = b"Caf=C3=A9 au l=\r\nait=\nnoir =3D ok";
        assert_eq!(
            decode_charset(
                &decode_transfer(raw, Some("quoted-printable"), false),
                Some("utf-8")
            ),
            "Café au laitnoir = ok"
        );
        assert_eq!(
            decode_transfer(b"abc=C", Some("quoted-printable"), true),
            b"abc"
        );
        assert_eq!(
            decode_transfer(b"abc=", Some("quoted-printable"), true),
            b"abc"
        );
        assert_eq!(
            decode_transfer(b"a=ZZ", Some("QUOTED-PRINTABLE"), false),
            b"a=ZZ"
        );
    }

    #[test]
    fn base64_partiel_et_tolerant() {
        assert_eq!(
            decode_transfer(b"SGVs\r\nbG8g\r\nd29y", Some("base64"), false),
            b"Hello wor"
        );
        // tronqué au milieu d'un groupe : seul le dernier groupe complet compte
        assert_eq!(
            decode_transfer(b"SGVsbG8gd29yb", Some("base64"), true),
            b"Hello wor"
        );
        assert_eq!(
            decode_transfer(b"SGVs*bG8=", Some("Base64"), false),
            b"Hello"
        );
        assert_eq!(decode_transfer(b"brut", None, false), b"brut");
    }

    #[test]
    fn jeux_de_caracteres() {
        assert_eq!(decode_charset(b"caf\xe9", Some("ISO-8859-1")), "café");
        assert_eq!(decode_charset(b"caf\xe9", Some("\"latin1\"")), "café");
        assert_eq!(
            decode_charset(b"\x80 \x93ok\x94", Some("windows-1252")),
            "€ “ok”"
        );
        // « こんにちは » en ISO-2022-JP
        assert_eq!(
            decode_charset(b"\x1b$B$3$s$K$A$O\x1b(B", Some("iso-2022-jp")),
            "こんにちは"
        );
        assert_eq!(decode_charset(b"\xef\xbb\xbfabc", None), "abc");
        assert_eq!(decode_charset(b"abc", Some("us-ascii")), "abc");
        assert_eq!(decode_charset(b"a\xffb", Some("x-inconnu")), "a\u{fffd}b");
    }

    #[test]
    fn apercu() {
        assert_eq!(
            make_preview("  un\n\tdeux   trois ", false),
            "un deux trois"
        );
        assert_eq!(
            make_preview("<p>Bonjour</p><p>le monde</p>", true),
            "Bonjour le monde"
        );
        let long = "é".repeat(300);
        let p = make_preview(&long, false);
        assert_eq!(p.chars().count(), 256);
        assert!(p.ends_with('…'));
        assert_eq!(make_preview(&"a".repeat(256), false).chars().count(), 256);
    }
}
