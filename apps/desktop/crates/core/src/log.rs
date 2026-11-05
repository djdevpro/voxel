//! Journal du cœur : une ligne sur la sortie d'erreur et les dernières lignes en mémoire, que l'auto-test relit.
//! Jamais d'URL complète, d'en-tête, de corps, d'identifiant ni d'adresse dans un message.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

/// Nombre de lignes gardées en mémoire.
const CAPACITY: usize = 500;

static RECENT: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn buffer() -> std::sync::MutexGuard<'static, VecDeque<String>> {
    RECENT
        .get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

pub fn warn(message: impl Into<String>) {
    let message = message.into();
    eprintln!("[voxel] {message}");
    let mut recent = buffer();
    if recent.len() == CAPACITY {
        recent.pop_front();
    }
    recent.push_back(message);
}

pub fn recent() -> Vec<String> {
    buffer().iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_last_lines() {
        for i in 0..CAPACITY + 3 {
            warn(format!("log-test {i}"));
        }
        let lines = recent();
        assert!(lines.len() <= CAPACITY);
        assert!(lines.contains(&format!("log-test {}", CAPACITY + 2)));
        assert!(!lines.contains(&"log-test 0".to_string()));
    }
}
