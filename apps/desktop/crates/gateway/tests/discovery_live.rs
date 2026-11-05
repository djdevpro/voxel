//! Découverte réelle de la boîte de test : son adresse doit mener à sa session JMAP.
//! Ignoré sans `VOXEL_TEST_USER` et `VOXEL_TEST_JMAP_URL` (environnement ou `.env.test.local`) ; rien n'est affiché.
//! `Discoverer` n'est pas public : la découverte passe par la route `POST /imap/discover`, qui l'appelle telle quelle.

use std::sync::Arc;

use voxel_core::backend::{BackendFactory, MailAccount, MailBackend};
use voxel_core::dns::SystemDns;
use voxel_core::http::{CoreBody, CoreRequest};
use voxel_core::kv::{KvStore, MemoryKv};
use voxel_core::net::HttpClient;
use voxel_gateway::{Gateway, KvProvider};

struct TestEnv {
    user: String,
    jmap_url: String,
}

impl TestEnv {
    fn load() -> Option<TestEnv> {
        const KEYS: [&str; 2] = ["VOXEL_TEST_USER", "VOXEL_TEST_JMAP_URL"];
        let mut file: Vec<(String, String)> = Vec::new();
        let mut dir = Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        while let Some(d) = dir {
            if let Ok(text) = std::fs::read_to_string(d.join(".env.test.local")) {
                file = text
                    .lines()
                    .filter_map(|l| l.split_once('='))
                    .map(|(k, v)| (k.trim().to_string(), v.trim_end_matches('\r').to_string()))
                    .collect();
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
        let get = |k: &str| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| file.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
        };
        let values: Vec<String> = KEYS.iter().map(|k| get(k)).collect::<Option<_>>()?;
        Some(TestEnv {
            user: values[0].clone(),
            jmap_url: values[1].clone(),
        })
    }
}

/// La découverte n'ouvre aucune façade.
struct NoFactory;

impl BackendFactory for NoFactory {
    fn create(&self, _account: MailAccount, _kv: Arc<dyn KvStore>) -> Arc<dyn MailBackend> {
        unreachable!("la découverte n'ouvre aucune façade")
    }
}

#[tokio::test]
async fn discovers_the_test_mailbox() {
    let Some(env) = TestEnv::load() else {
        return;
    };
    let kv: KvProvider = Arc::new(|_key: &str| Arc::new(MemoryKv::default()) as Arc<dyn KvStore>);
    let gateway = Gateway::new(
        Arc::new(NoFactory),
        kv,
        HttpClient::new().expect("client HTTP"),
        Arc::new(SystemDns::new().expect("DNS du système")),
    );
    let body = serde_json::json!({ "email": env.user }).to_string();
    let res = gateway
        .handle(CoreRequest {
            method: http::Method::POST,
            path: "/imap/discover".into(),
            headers: http::HeaderMap::new(),
            body: bytes::Bytes::from(body),
        })
        .await;
    assert_eq!(res.status, 200);
    let CoreBody::Full(body) = res.body else {
        panic!("corps entier attendu")
    };
    let json: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
    assert_eq!(json["protocol"], "jmap");
    // Comparaison seulement : aucune valeur n'apparaît dans un message d'échec.
    assert!(
        json["sessionUrl"].as_str() == Some(env.jmap_url.as_str()),
        "l'URL de session découverte diffère de VOXEL_TEST_JMAP_URL"
    );
}
