//! Ouverture TCP puis TLS vers le serveur IMAP. Copie volontaire de `voxel_core::net` (la crate reste
//! autonome) : toutes les adresses de l'hôte sont essayées, IPv4 d'abord, car une AAAA injoignable
//! (pas d'IPv6 sortant) ne doit pas bloquer la connexion. Aucun filtrage d'adresse (décision D6).

use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpStream;

use crate::ImapError;

pub type ImapStream = tokio_native_tls::TlsStream<tokio::net::TcpStream>;

fn unreachable(kind: std::io::ErrorKind) -> ImapError {
    ImapError::Unavailable(format!("IMAP server unreachable ({kind:?})"))
}

/// IPv4 d'abord, puis IPv6, ordre DNS gardé dans chaque famille.
fn prefer_ipv4(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let (v4, v6): (Vec<_>, Vec<_>) = addrs.into_iter().partition(|a| a.is_ipv4());
    v4.into_iter().chain(v6).collect()
}

/// Connexion TCP : chaque adresse est essayée sous `timeout`, la suivante seulement si l'ouverture échoue.
pub(crate) async fn tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, ImapError> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs = match tokio::time::timeout(timeout, tokio::net::lookup_host((bare, port))).await {
        Ok(Ok(it)) => prefer_ipv4(it.collect()),
        Ok(Err(e)) => return Err(unreachable(e.kind())),
        Err(_) => return Err(unreachable(std::io::ErrorKind::TimedOut)),
    };
    let mut last = std::io::ErrorKind::NotFound;
    for addr in addrs {
        match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => return Ok(s),
            Ok(Err(e)) => last = e.kind(),
            Err(_) => last = std::io::ErrorKind::TimedOut,
        }
    }
    Err(unreachable(last))
}

/// Poignée de main TLS (vérification du certificat par le système) sous `timeout`.
pub(crate) async fn tls(
    stream: TcpStream,
    domain: &str,
    timeout: Duration,
) -> Result<ImapStream, ImapError> {
    let tls_err = || ImapError::Unavailable("IMAP server unreachable (tls)".into());
    let connector = native_tls::TlsConnector::new().map_err(|_| tls_err())?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let domain = domain.trim_start_matches('[').trim_end_matches(']');
    match tokio::time::timeout(timeout, connector.connect(domain, stream)).await {
        Ok(Ok(s)) => Ok(s),
        _ => Err(tls_err()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_d_abord() {
        let a: SocketAddr = "[::1]:993".parse().unwrap();
        let b: SocketAddr = "127.0.0.1:993".parse().unwrap();
        let c: SocketAddr = "10.0.0.1:993".parse().unwrap();
        assert_eq!(prefer_ipv4(vec![a, b, c]), vec![b, c, a]);
    }

    #[tokio::test]
    async fn port_ferme_injoignable() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let e = tcp("127.0.0.1", port, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(
            matches!(e, ImapError::Unavailable(ref t) if t.starts_with("IMAP server unreachable ("))
        );
    }
}
