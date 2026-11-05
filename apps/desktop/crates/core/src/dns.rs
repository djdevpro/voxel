//! Enregistrements MX, SRV et TXT de la découverte de serveurs, par le résolveur du système.
//! Toute erreur donne un résultat vide, comme `discovery.ts` : la découverte essaie alors la piste suivante.

use futures_util::future::BoxFuture;
use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;

pub trait DnsLookup: Send + Sync {
    /// Échanges triés par préférence, en minuscules, sans point final ; vide si erreur.
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Vec<String>>;
    /// Meilleure cible (priorité croissante puis poids décroissant), cible "." ignorée.
    fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<(String, u16)>>;
    /// Chaque enregistrement concaténé.
    fn txt<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Vec<String>>;
}

pub struct SystemDns {
    resolver: TokioResolver,
}

impl SystemDns {
    pub fn new() -> Result<Self, String> {
        let resolver = TokioResolver::builder_tokio()
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { resolver })
    }
}

fn host_of(name: &hickory_resolver::proto::rr::Name) -> String {
    name.to_ascii().trim_end_matches('.').to_lowercase()
}

impl DnsLookup for SystemDns {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let Ok(lookup) = self.resolver.mx_lookup(domain).await else {
                return Vec::new();
            };
            let mut records: Vec<(u16, String)> = lookup
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::MX(mx) => Some((mx.preference, host_of(&mx.exchange))),
                    _ => None,
                })
                .filter(|(_, host)| !host.is_empty())
                .collect();
            records.sort_by_key(|(preference, _)| *preference);
            records.into_iter().map(|(_, host)| host).collect()
        })
    }

    fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<(String, u16)>> {
        Box::pin(async move {
            let lookup = self.resolver.srv_lookup(name).await.ok()?;
            let mut records: Vec<(u16, u16, String, u16)> = lookup
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::SRV(srv) => {
                        Some((srv.priority, srv.weight, host_of(&srv.target), srv.port))
                    }
                    _ => None,
                })
                .filter(|(_, _, host, _)| !host.is_empty())
                .collect();
            records.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
            records
                .into_iter()
                .next()
                .map(|(_, _, host, port)| (host, port))
        })
    }

    fn txt<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let Ok(lookup) = self.resolver.txt_lookup(name).await else {
                return Vec::new();
            };
            lookup
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::TXT(txt) => Some(
                        txt.txt_data
                            .iter()
                            .map(|part| String::from_utf8_lossy(part))
                            .collect::<String>(),
                    ),
                    _ => None,
                })
                .collect()
        })
    }
}
