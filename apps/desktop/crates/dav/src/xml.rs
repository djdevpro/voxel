//! Lecture des réponses `multistatus` (RFC 4918) et petits outils XML du client WebDAV. Port de `parseMultistatus`,
//! `textProp`, `hrefProp`, `statusCode`, `normalizeColor` et `xmlEscape` (`apps/server/src/carddav/dav.ts`) :
//! noms locaux seulement (espaces de noms ignorés), seules les `propstat` sans statut ou en 2xx sont réunies.

use crate::client::DavError;

/// Profondeur maximale lue dans un `multistatus` (multistatus/response/propstat/prop/… en utilise moins de 10).
const MAX_DEPTH: usize = 32;

/// Élément XML lu, sans attributs : texte (s'il n'a pas d'enfant élément) et enfants.
#[derive(Debug, Clone)]
struct Element {
    name: String,
    text: String,
    children: Vec<Element>,
}

impl Element {
    /// Conversion bornée en profondeur : au-delà de `MAX_DEPTH`, les enfants sont ignorés (pas de débordement de pile).
    fn from_node(node: roxmltree::Node<'_, '_>, depth: usize) -> Self {
        let children: Vec<Element> = if depth >= MAX_DEPTH {
            Vec::new()
        } else {
            node.children()
                .filter(|c| c.is_element())
                .map(|c| Element::from_node(c, depth + 1))
                .collect()
        };
        let text: String = node
            .children()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text())
            .collect();
        Self {
            name: node.tag_name().name().to_string(),
            text: text.trim().to_string(),
            children,
        }
    }

    fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    fn any_descendant(&self, names: &[&str]) -> bool {
        self.children
            .iter()
            .any(|c| names.contains(&c.name.as_str()) || c.any_descendant(names))
    }
}

/// Propriétés trouvées pour une ressource (toutes les `prop` des `propstat` retenues, la dernière l'emporte).
#[derive(Debug, Clone, Default)]
pub struct PropSet {
    props: Vec<Element>,
}

impl PropSet {
    fn get(&self, local: &str) -> Option<&Element> {
        self.props.iter().rev().find(|p| p.name == local)
    }

    /// Texte d'une propriété sans enfant élément (`textProp`).
    pub fn text(&self, local: &str) -> Option<String> {
        self.get(local)
            .filter(|p| p.children.is_empty())
            .map(|p| p.text.clone())
    }

    /// Premier href contenu dans une propriété (`<current-user-principal><href>…`).
    pub fn href(&self, local: &str) -> Option<String> {
        self.get(local)?
            .child("href")
            .map(|h| h.text.clone())
            .filter(|h| !h.is_empty())
    }

    pub fn has_child(&self, local: &str, child: &str) -> bool {
        self.get(local).is_some_and(|p| p.child(child).is_some())
    }

    pub fn contains_any(&self, local: &str, names: &[&str]) -> bool {
        self.get(local).is_some_and(|p| p.any_descendant(names))
    }

    /// La propriété est présente avec au moins un enfant élément.
    pub(crate) fn has_children(&self, local: &str) -> bool {
        self.get(local).is_some_and(|p| !p.children.is_empty())
    }
}

pub struct DavResponseEntry {
    pub href: String,
    /// Statut global (`<status>` hors propstat), ex. 404 d'un multiget.
    pub status: Option<u16>,
    pub props: PropSet,
}

/// `HTTP/1.1 200 OK` → 200.
fn status_code(text: &str) -> Option<u16> {
    let bytes = text.as_bytes();
    (0..bytes.len()).find_map(|i| {
        let digits = bytes.get(i + 1..i + 4)?;
        let ok = bytes[i].is_ascii_whitespace() && digits.iter().all(u8::is_ascii_digit);
        ok.then(|| text[i + 1..i + 4].parse().ok()).flatten()
    })
}

/// `<multistatus>` → réponses (href, statut, propriétés 2xx) et `sync-token` éventuel.
pub fn parse_multistatus(xml: &str) -> Result<(Vec<DavResponseEntry>, Option<String>), DavError> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let doc = roxmltree::Document::parse_with_options(xml, options)
        .map_err(|_| DavError::Network("invalid multistatus XML".into()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "multistatus" {
        return Ok((Vec::new(), None));
    }
    let ms = Element::from_node(root, 0);
    let mut responses = Vec::new();
    for r in ms.children.iter().filter(|c| c.name == "response") {
        let href = r.child("href").map(|h| h.text.clone()).unwrap_or_default();
        let mut props = PropSet::default();
        for ps in r.children.iter().filter(|c| c.name == "propstat") {
            if let Some(code) = ps.child("status").and_then(|s| status_code(&s.text))
                && !(200..300).contains(&code)
            {
                continue;
            }
            if let Some(prop) = ps.child("prop") {
                props.props.extend(prop.children.iter().cloned());
            }
        }
        responses.push(DavResponseEntry {
            href,
            status: r.child("status").and_then(|s| status_code(&s.text)),
            props,
        });
    }
    let token = ms
        .child("sync-token")
        .filter(|t| t.children.is_empty() && !t.text.is_empty())
        .map(|t| t.text.clone());
    Ok((responses, token))
}

pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `#RRGGBBAA` (Apple) → `#RRGGBB` ; autre valeur : `None`.
pub fn normalize_color(value: &str) -> Option<String> {
    let hex = value.trim().strip_prefix('#')?;
    if (hex.len() != 6 && hex.len() != 8) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex[..6].to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multistatus_entities_cdata_and_status() {
        let (responses, token) = parse_multistatus(
            "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\" xmlns:B=\"urn:ietf:params:xml:ns:carddav\"><D:response><D:href>/a.vcf</D:href><D:propstat><D:prop><D:getetag>&quot;1&quot;</D:getetag><B:address-data><![CDATA[BEGIN:VCARD\nFN:a & b\nEND:VCARD]]></B:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response><D:response><D:href>/b.vcf</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response><D:sync-token>t1</D:sync-token></D:multistatus>",
        )
        .unwrap();
        assert_eq!(token.as_deref(), Some("t1"));
        assert_eq!(responses[0].props.text("getetag").as_deref(), Some("\"1\""));
        assert!(
            responses[0]
                .props
                .text("address-data")
                .unwrap()
                .contains("FN:a & b")
        );
        assert_eq!(responses[0].props.text("displayname"), None);
        assert_eq!(responses[1].status, Some(404));
    }

    #[test]
    fn deep_nesting_does_not_overflow() {
        let depth = 20_000;
        let xml = format!(
            "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/a</d:href><d:propstat><d:prop>{}{}</d:prop></d:propstat></d:response></d:multistatus>",
            "<d:x>".repeat(depth),
            "</d:x>".repeat(depth)
        );
        // pile courte, comme un fil de travail : un parcours récursif déborderait
        let handle = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || parse_multistatus(&xml).map(|(r, _)| r.len()))
            .unwrap();
        let parsed = handle.join().expect("pas de débordement de pile");
        assert!(matches!(parsed, Ok(1) | Err(_)));
    }

    #[test]
    fn colors_and_escape() {
        assert_eq!(normalize_color("#FF0000FF").as_deref(), Some("#ff0000"));
        assert_eq!(normalize_color(" #00ff00 ").as_deref(), Some("#00ff00"));
        assert_eq!(normalize_color("red"), None);
        assert_eq!(xml_escape("a<&>"), "a&lt;&amp;&gt;");
    }
}
