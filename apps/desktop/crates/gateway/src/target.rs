//! Boîte visée par une requête, lue dans ses en-têtes (port de `parseBasic`, `parseEndpoint` et `targetOf`, `routes/imap.ts`) :
//! chaque requête porte ses identifiants et ses serveurs, rien n'est gardé entre deux appels. Aucun appel réseau ici.
//! Écarts D6 : tout port est accepté, et les URL DAV suivent `parse_dav_url` (https partout, http vers la boucle locale).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;
use voxel_core::backend::{Endpoint, MailAccount};
use voxel_core::error::{ApiError, ErrorCode};
use voxel_core::net::parse_dav_url;

/// Longueur maximale d'un identifiant ou d'une adresse (unités UTF-16, comme JS).
const MAX_USERNAME: usize = 320;

/// Longueur maximale d'un mot de passe (unités UTF-16, comme JS).
const MAX_PASSWORD: usize = 1024;

/// `Authorization: Basic …`.
static BASIC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Basic\s+([A-Za-z0-9+/=]+)\s*$").expect("expression Basic"));

/// Nom d'hôte ou adresse IPv6 entre crochets.
static HOST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9.-]{1,253}$|^\[[0-9a-f:]{2,45}\]$").expect("expression d'hôte")
});

/// Adresse donnée par `X-Voxel-Email`.
static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+$").expect("expression d'adresse"));

/// Base64 aussi tolérant que `Buffer.from(…, 'base64')` sur le remplissage.
const LENIENT_BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Debug, Clone)]
pub struct GatewayTarget {
    pub username: String,
    pub password: String,
    pub email: Option<String>,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    pub sieve: Option<Endpoint>,
    pub carddav: Option<String>,
    pub caldav: Option<String>,
}

impl GatewayTarget {
    pub fn account(&self) -> MailAccount {
        MailAccount {
            email: self.email.clone().unwrap_or_else(|| self.username.clone()),
            username: self.username.clone(),
            password: self.password.clone(),
            imap: self.imap.clone(),
            smtp: self.smtp.clone(),
            sieve: self.sieve.clone(),
            carddav: self.carddav.clone(),
            caldav: self.caldav.clone(),
        }
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Number(text)` limité aux entiers décimaux : `None` si illisible ou fractionnaire.
pub(crate) fn js_integer(text: &str) -> Option<i64> {
    let text = text.trim();
    let n = if text.is_empty() {
        0.0
    } else {
        text.parse::<f64>().ok()?
    };
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

/// `Authorization: Basic base64(utf8(username:password))` ; `None` si absent ou mal formé.
pub fn parse_basic(header: Option<&str>) -> Option<(String, String)> {
    let m = BASIC_RE.captures(header?)?;
    let encoded = m[1].split('=').next().unwrap_or("");
    let text = String::from_utf8(LENIENT_BASE64.decode(encoded).ok()?).ok()?;
    let i = text.find(':').filter(|&i| i > 0)?;
    let username = text[..i].trim().to_string();
    let password = text[i + 1..].to_string();
    if username.is_empty()
        || password.is_empty()
        || utf16_len(&username) > MAX_USERNAME
        || utf16_len(&password) > MAX_PASSWORD
    {
        return None;
    }
    Some((username, password))
}

/// `<hôte>:<port>:<ssl|starttls>` ; `None` si mal formé.
pub fn parse_endpoint(header: Option<&str>) -> Option<Endpoint> {
    let lower = header?.trim().to_lowercase();
    let mut parts: Vec<&str> = lower.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let security = parts.pop()?;
    let port = js_integer(parts.pop()?)?;
    let host = parts.join(":");
    if !HOST_RE.is_match(&host) || !(1..=65535).contains(&port) {
        return None;
    }
    if security != "ssl" && security != "starttls" {
        return None;
    }
    let bare = host.strip_prefix('[').unwrap_or(&host);
    let bare = bare.strip_suffix(']').unwrap_or(bare);
    Some(Endpoint {
        host: bare.to_string(),
        port: port as u16,
        secure: security == "ssl",
    })
}

fn header<'a>(headers: &'a http::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn validation(message: &str) -> ApiError {
    ApiError::new(400, ErrorCode::Validation, message)
}

/// Lit et valide les en-têtes ; aucun appel réseau.
pub fn target_of(headers: &http::HeaderMap) -> Result<GatewayTarget, ApiError> {
    let (username, password) = parse_basic(header(headers, "authorization")).ok_or_else(|| {
        ApiError::new(
            401,
            ErrorCode::InvalidCredentials,
            "Basic credentials required",
        )
    })?;
    let imap = parse_endpoint(header(headers, "x-voxel-imap"));
    let smtp = parse_endpoint(header(headers, "x-voxel-smtp"));
    let (Some(imap), Some(smtp)) = (imap, smtp) else {
        return Err(validation(
            "X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)",
        ));
    };
    let given = header(headers, "x-voxel-email").map(|v| v.trim().to_lowercase());
    if let Some(given) = &given
        && (utf16_len(given) > MAX_USERNAME || !EMAIL_RE.is_match(given))
    {
        return Err(validation("X-Voxel-Email must be an email address"));
    }
    let email = given
        .filter(|g| !g.is_empty())
        .or_else(|| username.contains('@').then(|| username.to_lowercase()));
    // ManageSieve : facultatif ; mal formé → 400
    let sieve = match header(headers, "x-voxel-sieve").filter(|v| !v.is_empty()) {
        Some(v) => Some(
            parse_endpoint(Some(v))
                .ok_or_else(|| validation("X-Voxel-Sieve must be host:port:ssl|starttls"))?,
        ),
        None => None,
    };
    let dav = |name: &str, message: &str| -> Result<Option<String>, ApiError> {
        match header(headers, name).filter(|v| !v.is_empty()) {
            Some(v) => Ok(Some(
                parse_dav_url(v)
                    .ok_or_else(|| validation(message))?
                    .to_string(),
            )),
            None => Ok(None),
        }
    };
    let carddav = dav("x-voxel-carddav", "X-Voxel-CardDav must be an https URL")?;
    let caldav = dav("x-voxel-caldav", "X-Voxel-CalDav must be an https URL")?;
    Ok(GatewayTarget {
        username,
        password,
        email,
        imap,
        smtp,
        sieve,
        carddav,
        caldav,
    })
}
