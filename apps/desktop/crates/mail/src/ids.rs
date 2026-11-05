//! Identifiants d'emails et ensembles d'UID (port de `util.ts`) : un id d'email porte son dossier, l'UIDVALIDITY
//! et l'UID, ce qui évite toute table de correspondance ; un MOVE crée un alias (voir `messages`).

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EmailKey {
    pub mb_id: String,
    pub uid_validity: u32,
    pub uid: u32,
}

fn to_base36(mut v: u64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if v == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while v > 0 {
        out.push(ALPHABET[(v % 36) as usize]);
        v /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Id d'email = `<mailboxId>-<UIDVALIDITY base36>-<UID base36>` (id de dossier en [a-z0-9], préfixe `m`).
pub fn encode_email_id(mb_id: &str, uid_validity: u32, uid: u32) -> String {
    format!(
        "{mb_id}-{}-{}",
        to_base36(uid_validity as u64),
        to_base36(uid as u64)
    )
}

/// `parseInt(s, 36)` : préfixe alphanumérique (casse ignorée) lu, le reste ignoré ; rien de lisible → None.
fn parse_int36(s: &str) -> Option<u64> {
    let digits: String = s
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if digits.is_empty() {
        return None;
    }
    u64::from_str_radix(&digits.to_lowercase(), 36).ok()
}

pub fn decode_email_id(id: &str) -> Option<EmailKey> {
    if !id.starts_with('m') {
        return None;
    }
    let parts: Vec<&str> = id.split('-').collect();
    let [mb_id, v, u] = parts.as_slice() else {
        return None;
    };
    let base36 = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
    };
    if mb_id.len() < 2 || !base36(&mb_id[1..]) || !base36(v) {
        return None;
    }
    let uid_validity = u32::try_from(u64::from_str_radix(v, 36).ok()?).ok()?;
    let uid = u32::try_from(parse_int36(u)?).ok()?;
    if uid == 0 {
        return None;
    }
    Some(EmailKey {
        mb_id: mb_id.to_string(),
        uid_validity,
        uid,
    })
}

/// Ensemble de séquences IMAP compact (`1:4,7,9:12`) à partir d'UID.
pub fn to_seq_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        out.push(if start == end {
            start.to_string()
        } else {
            format!("{start}:{end}")
        });
        i += 1;
    }
    out.join(",")
}

pub fn chunk<T: Clone>(list: &[T], size: usize) -> Vec<Vec<T>> {
    list.chunks(size.max(1)).map(|c| c.to_vec()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aller_retour_des_identifiants() {
        let id = encode_email_id("mab12c", 1_700_000_000, 4242);
        assert_eq!(id, "mab12c-s44we8-39u");
        assert_eq!(
            decode_email_id(&id),
            Some(EmailKey {
                mb_id: "mab12c".into(),
                uid_validity: 1_700_000_000,
                uid: 4242
            })
        );
        assert_eq!(decode_email_id("xab-1-1"), None);
        assert_eq!(decode_email_id("mab-1"), None);
        assert_eq!(decode_email_id("mAB-1-1"), None);
        assert_eq!(decode_email_id("mab-1-0"), None);
        assert_eq!(decode_email_id("m-1-1"), None);
    }

    #[test]
    fn ensembles_et_paquets() {
        assert_eq!(to_seq_set(&[1, 2, 3, 7, 9, 10, 11, 12]), "1:3,7,9:12");
        assert_eq!(to_seq_set(&[5, 3, 4, 4]), "3:5");
        assert_eq!(to_seq_set(&[]), "");
        assert_eq!(
            chunk(&[1, 2, 3, 4, 5], 2),
            vec![vec![1, 2], vec![3, 4], vec![5]]
        );
    }
}
