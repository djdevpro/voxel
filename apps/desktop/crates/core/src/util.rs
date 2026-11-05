//! Outils communs : empreintes, identifiants aléatoires, dates, base64url, texte sans accents et cache LRU.
//! Port de `apps/server/src/imap/util.ts`, `crypto.ts` et `foldText` (`packages/jmap/src/jscontact.ts`),
//! pour que les identifiants et les états restent ceux de la façade Node.

use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// Alphabet de `randomBase36`.
const BASE36: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    getrandom::fill(&mut buf).expect("aléa du système indisponible");
    buf
}

pub fn hash_of(input: &str, len: usize) -> String {
    let mut out = base64url_encode(&Sha256::digest(input.as_bytes()));
    out.truncate(len);
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn random_hex(bytes: usize) -> String {
    random_bytes(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Id court en base 36 (caractères [a-z0-9]).
pub fn random_base36(len: usize) -> String {
    random_bytes(len)
        .iter()
        .map(|b| BASE36[(*b % 36) as usize] as char)
        .collect()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `YYYY-MM-DDTHH:MM:SSZ`, sans millisecondes.
pub fn utc_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}

pub fn base64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

/// Texte de recherche : sans diacritiques, en minuscules, sans espaces autour.
pub fn fold_text(text: &str) -> String {
    let nfd = icu_normalizer::DecomposingNormalizerBorrowed::new_nfd().normalize(text);
    let stripped: String = nfd
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    stripped.to_lowercase().trim().to_string()
}

/// Cache LRU : chaque lecture rafraîchit l'entrée, l'insertion évince la plus ancienne au-delà de `max`.
pub struct Lru<K, V> {
    max: usize,
    tick: u64,
    entries: HashMap<K, (V, u64)>,
    order: BTreeMap<u64, K>,
}

impl<K: Eq + Hash + Clone, V> Lru<K, V> {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            tick: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    fn touch(&mut self, key: &K) -> bool {
        let Some(entry) = self.entries.get_mut(key) else {
            return false;
        };
        self.tick += 1;
        self.order.remove(&entry.1);
        entry.1 = self.tick;
        self.order.insert(self.tick, key.clone());
        true
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        if !self.touch(key) {
            return None;
        }
        self.entries.get(key).map(|(v, _)| v)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        if !self.touch(key) {
            return None;
        }
        self.entries.get_mut(key).map(|(v, _)| v)
    }

    pub fn contains(&self, key: &K) -> bool {
        self.entries.contains_key(key)
    }

    pub fn insert(&mut self, key: K, value: V) {
        self.remove(&key);
        self.tick += 1;
        self.order.insert(self.tick, key.clone());
        self.entries.insert(key, (value, self.tick));
        while self.entries.len() > self.max {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        let (value, tick) = self.entries.remove(key)?;
        self.order.remove(&tick);
        Some(value)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_node() {
        assert_eq!(hash_of("abc", 16), "ungWv48Bz-pBQUDe");
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn dates() {
        assert_eq!(utc_date(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_date(1_700_000_000_123), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn random_ids() {
        assert_eq!(random_hex(6).len(), 12);
        let id = random_base36(20);
        assert_eq!(id.len(), 20);
        assert!(id.bytes().all(|b| BASE36.contains(&b)));
    }

    #[test]
    fn base64url() {
        assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url_decode("-_8").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(base64url_decode("-_8=").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(base64url_decode("*"), None);
    }

    #[test]
    fn fold() {
        assert_eq!(fold_text("  Élodie "), "elodie");
    }

    #[test]
    fn lru() {
        let mut c = Lru::new(2);
        c.insert("a", 1);
        c.insert("b", 2);
        assert_eq!(c.get(&"a"), Some(&1));
        c.insert("c", 3);
        assert!(c.contains(&"a") && c.contains(&"c") && !c.contains(&"b"));
        *c.get_mut(&"c").unwrap() = 30;
        c.insert("d", 4);
        assert!(!c.contains(&"a"));
        assert_eq!(c.get(&"c"), Some(&30));
        assert_eq!(c.remove(&"d"), Some(4));
        assert_eq!(c.len(), 1);
        c.clear();
        assert!(c.is_empty());
    }
}
