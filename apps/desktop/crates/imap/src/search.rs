//! Critères de recherche IMAP (remplace l'objet `SearchObject` d'imapflow et son compilateur) :
//! la façade construit un `SearchKey`, la session l'envoie tel quel dans `UID SEARCH`.

use crate::ImapError;
use crate::names::format_flag;
use crate::session::{Piece, check_header_name, check_text, check_uid_set};

#[derive(Debug, Clone, PartialEq)]
pub enum SearchKey {
    All,
    Seen(bool),
    Flagged(bool),
    Answered(bool),
    Draft(bool),
    Keyword(String),
    UnKeyword(String),
    From(String),
    To(String),
    Cc(String),
    Bcc(String),
    Subject(String),
    Body(String),
    Text(String),
    Before(chrono::NaiveDate),
    Since(chrono::NaiveDate),
    Larger(u64),
    Smaller(u64),
    Header(String, Option<String>),
    Uid(String),
    And(Vec<SearchKey>),
    Or(Vec<SearchKey>),
    Not(Box<SearchKey>),
}

/// Morceaux d'un critère en construction ; les textes voisins sont fusionnés.
struct Out {
    pieces: Vec<Piece>,
    utf8: bool,
}

impl Out {
    fn text(&mut self, t: &str) {
        if let Some(Piece::Text(last)) = self.pieces.last_mut() {
            last.push_str(t);
        } else {
            self.pieces.push(Piece::Text(t.to_string()));
        }
    }

    /// Chaîne IMAP : citée si ASCII imprimable, sinon littéral (la session choisit `{n+}` avec LITERAL+,
    /// sinon `{n}` synchronisant) et `CHARSET UTF-8` demandé. CR, LF ou NUL → `Command` (C15).
    fn string(&mut self, s: &str) -> Result<(), ImapError> {
        check_text(s)?;
        if s.bytes().all(|b| (0x20..0x7f).contains(&b)) {
            self.text(&quoted(s));
        } else {
            self.pieces.push(Piece::Literal(s.as_bytes().to_vec()));
            self.utf8 = true;
        }
        Ok(())
    }
}

fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn date(d: &chrono::NaiveDate) -> String {
    d.format("%-d-%b-%Y").to_string()
}

fn keyword(k: &str) -> Result<String, ImapError> {
    format_flag(k).ok_or_else(|| ImapError::Command("invalid keyword".into()))
}

impl SearchKey {
    /// (critère en morceaux, besoin de CHARSET UTF-8). La forme des littéraux (`{n+}` ou `{n}`) est
    /// choisie par la session selon LITERAL+ ; `literal_plus` est gardé pour la signature de la spec.
    pub(crate) fn to_imap(&self, _literal_plus: bool) -> Result<(Vec<Piece>, bool), ImapError> {
        let mut out = Out {
            pieces: Vec::new(),
            utf8: false,
        };
        self.emit(&mut out)?;
        Ok((out.pieces, out.utf8))
    }

    fn emit(&self, out: &mut Out) -> Result<(), ImapError> {
        let flag =
            |out: &mut Out, on: bool, yes: &str, no: &str| out.text(if on { yes } else { no });
        let with = |out: &mut Out, name: &str, s: &str| {
            out.text(name);
            out.text(" ");
            out.string(s)
        };
        match self {
            SearchKey::All => out.text("ALL"),
            SearchKey::Seen(on) => flag(out, *on, "SEEN", "UNSEEN"),
            SearchKey::Flagged(on) => flag(out, *on, "FLAGGED", "UNFLAGGED"),
            SearchKey::Answered(on) => flag(out, *on, "ANSWERED", "UNANSWERED"),
            SearchKey::Draft(on) => flag(out, *on, "DRAFT", "UNDRAFT"),
            SearchKey::Keyword(k) => out.text(&format!("KEYWORD {}", keyword(k)?)),
            SearchKey::UnKeyword(k) => out.text(&format!("UNKEYWORD {}", keyword(k)?)),
            SearchKey::From(s) => with(out, "FROM", s)?,
            SearchKey::To(s) => with(out, "TO", s)?,
            SearchKey::Cc(s) => with(out, "CC", s)?,
            SearchKey::Bcc(s) => with(out, "BCC", s)?,
            SearchKey::Subject(s) => with(out, "SUBJECT", s)?,
            SearchKey::Body(s) => with(out, "BODY", s)?,
            SearchKey::Text(s) => with(out, "TEXT", s)?,
            SearchKey::Before(d) => out.text(&format!("BEFORE {}", date(d))),
            SearchKey::Since(d) => out.text(&format!("SINCE {}", date(d))),
            SearchKey::Larger(n) => out.text(&format!("LARGER {n}")),
            SearchKey::Smaller(n) => out.text(&format!("SMALLER {n}")),
            SearchKey::Header(name, value) => {
                check_header_name(name)?;
                out.text("HEADER ");
                out.string(name)?;
                out.text(" ");
                out.string(value.as_deref().unwrap_or(""))?;
            }
            SearchKey::Uid(set) => {
                check_uid_set(set)?;
                out.text(&format!("UID {set}"));
            }
            SearchKey::And(items) => match items.as_slice() {
                [] => out.text("ALL"),
                [a] => a.emit(out)?,
                _ => {
                    out.text("(");
                    for (i, k) in items.iter().enumerate() {
                        if i > 0 {
                            out.text(" ");
                        }
                        k.emit(out)?;
                    }
                    out.text(")");
                }
            },
            SearchKey::Or(items) => match items.as_slice() {
                [] => out.text("ALL"),
                [a] => a.emit(out)?,
                [a, rest @ ..] => {
                    out.text("OR ");
                    a.emit(out)?;
                    out.text(" ");
                    if rest.len() == 1 {
                        rest[0].emit(out)?;
                    } else {
                        out.text("(");
                        SearchKey::Or(rest.to_vec()).emit(out)?;
                        out.text(")");
                    }
                }
            },
            SearchKey::Not(k) => {
                out.text("NOT (");
                k.emit(out)?;
                out.text(")");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::SearchKey as K;
    use crate::ImapError;
    use crate::session::Piece;
    use chrono::NaiveDate;

    /// Rendu lisible : un littéral s'écrit `{n}\r\n…`.
    fn render(k: &K) -> Result<(String, bool), ImapError> {
        let (pieces, utf8) = k.to_imap(false)?;
        let mut out = String::new();
        for p in pieces {
            match p {
                Piece::Text(t) => out.push_str(&t),
                Piece::Literal(b) => out.push_str(&format!(
                    "{{{}}}\r\n{}",
                    b.len(),
                    String::from_utf8(b).unwrap()
                )),
            }
        }
        Ok((out, utf8))
    }

    fn s(k: K) -> String {
        render(&k).unwrap().0
    }

    #[test]
    fn chaque_variante() {
        assert_eq!(s(K::All), "ALL");
        assert_eq!(s(K::Seen(true)), "SEEN");
        assert_eq!(s(K::Seen(false)), "UNSEEN");
        assert_eq!(s(K::Flagged(true)), "FLAGGED");
        assert_eq!(s(K::Flagged(false)), "UNFLAGGED");
        assert_eq!(s(K::Answered(true)), "ANSWERED");
        assert_eq!(s(K::Answered(false)), "UNANSWERED");
        assert_eq!(s(K::Draft(true)), "DRAFT");
        assert_eq!(s(K::Draft(false)), "UNDRAFT");
        assert_eq!(s(K::Keyword("$label1".into())), "KEYWORD $label1");
        assert_eq!(s(K::UnKeyword("$junk".into())), "UNKEYWORD $junk");
        assert_eq!(s(K::Keyword("\\seen".into())), "KEYWORD \\Seen");
        assert_eq!(s(K::From("a@b".into())), "FROM \"a@b\"");
        assert_eq!(s(K::To("t".into())), "TO \"t\"");
        assert_eq!(s(K::Cc("c".into())), "CC \"c\"");
        assert_eq!(s(K::Bcc("b".into())), "BCC \"b\"");
        assert_eq!(s(K::Subject("hello".into())), "SUBJECT \"hello\"");
        assert_eq!(s(K::Body("x".into())), "BODY \"x\"");
        assert_eq!(s(K::Text("y".into())), "TEXT \"y\"");
        assert_eq!(
            s(K::Before(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap())),
            "BEFORE 1-Jan-2026"
        );
        assert_eq!(
            s(K::Since(NaiveDate::from_ymd_opt(2026, 11, 25).unwrap())),
            "SINCE 25-Nov-2026"
        );
        assert_eq!(s(K::Larger(100)), "LARGER 100");
        assert_eq!(s(K::Smaller(5)), "SMALLER 5");
        assert_eq!(
            s(K::Header("Message-ID".into(), None)),
            "HEADER \"Message-ID\" \"\""
        );
        assert_eq!(
            s(K::Header("Message-ID".into(), Some("<a@b>".into()))),
            "HEADER \"Message-ID\" \"<a@b>\""
        );
        assert_eq!(s(K::Uid("1:5,7,9:*".into())), "UID 1:5,7,9:*");
        assert_eq!(s(K::And(vec![K::Seen(true)])), "SEEN");
        assert_eq!(
            s(K::And(vec![K::Seen(true), K::Flagged(false)])),
            "(SEEN UNFLAGGED)"
        );
        assert_eq!(s(K::Or(vec![K::Seen(true)])), "SEEN");
        assert_eq!(
            s(K::Or(vec![K::Seen(true), K::Draft(true)])),
            "OR SEEN DRAFT"
        );
        assert_eq!(s(K::Not(Box::new(K::Seen(true)))), "NOT (SEEN)");
    }

    #[test]
    fn or_a_trois_termes() {
        let k = K::Or(vec![
            K::From("a".into()),
            K::To("b".into()),
            K::Cc("c".into()),
        ]);
        assert_eq!(s(k), "OR FROM \"a\" (OR TO \"b\" CC \"c\")");
        let k = K::Or(vec![
            K::Seen(true),
            K::Draft(true),
            K::Flagged(true),
            K::Answered(true),
        ]);
        assert_eq!(s(k), "OR SEEN (OR DRAFT (OR FLAGGED ANSWERED))");
    }

    #[test]
    fn echappement_et_litteral() {
        assert_eq!(
            render(&K::Subject(r#"il a dit "oui" \o/"#.into())).unwrap(),
            (r#"SUBJECT "il a dit \"oui\" \\o/""#.to_string(), false)
        );
        // non-ASCII : littéral (synchronisant sans LITERAL+, choisi par la session), jamais une chaîne citée
        let (pieces, utf8) = K::Subject("été".into()).to_imap(false).unwrap();
        assert!(utf8);
        assert!(
            matches!(&pieces[..], [Piece::Text(t), Piece::Literal(b)] if t == "SUBJECT " && b == "été".as_bytes())
        );
        assert_eq!(s(K::Subject("été".into())), "SUBJECT {5}\r\nété");
        let (_, utf8) = render(&K::And(vec![
            K::Seen(true),
            K::Not(Box::new(K::Body("ça".into()))),
        ]))
        .unwrap();
        assert!(utf8);
    }

    #[test]
    fn injections_refusees() {
        let refused = |k: K| matches!(k.to_imap(false), Err(ImapError::Command(_)));
        assert!(refused(K::Subject("a\r\nA1 DELETE INBOX".into())));
        assert!(refused(K::Text("a\nb".into())));
        assert!(refused(K::Body("a\0b".into())));
        assert!(refused(K::Subject("é\r\n".into())));
        assert!(refused(K::Header("Subject".into(), Some("x\r\ny".into()))));
        assert!(refused(K::Keyword("bad flag".into())));
        assert!(refused(K::UnKeyword("x)\r\nA2 EXPUNGE".into())));
        assert!(refused(K::Keyword("\\Recent".into())));
        assert!(refused(K::Header("X Y".into(), None)));
        assert!(refused(K::Header("X:Y".into(), None)));
        assert!(refused(K::Header(String::new(), None)));
        assert!(refused(K::Uid("1:5 OR ALL".into())));
        assert!(refused(K::Uid("".into())));
        assert!(refused(K::Or(vec![
            K::Seen(true),
            K::Subject("a\rb".into())
        ])));
    }
}
