//! Transport réseau de l'interface (protocole `net_fetch`) : chaque requête de la page arrive ici par l'IPC, part vers la passerelle /imap/* en process ou vers le client HTTP du cœur, et sa réponse revient en flux par un `Channel`. Le client HTTP est en Rust : CORS ne s'applique plus.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use bytes::Bytes;
use futures_util::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, JavaScriptChannelId, Request};
use tauri::{AppHandle, Manager, Webview};
use voxel_core::http::{CoreBody, CoreRequest};
use voxel_core::net::{FetchOptions, HttpRequest, check_url};

use crate::Core;

/// Taille à partir de laquelle les morceaux accumulés partent sans attendre.
const CHUNK: usize = 262_144;
/// En-têtes de requête que le transport fixe lui-même.
const REQUEST_SKIPPED: &[&str] = &["host", "content-length", "connection", "transfer-encoding"];
/// En-têtes de réponse propres à la connexion amont, sans objet pour la page.
const RESPONSE_SKIPPED: &[&str] = &["connection", "transfer-encoding", "keep-alive"];

/// Requêtes en cours (ouverture puis pompage), par vue et numéro de requête.
#[derive(Default)]
pub(crate) struct Requests(std::sync::Mutex<Table>);

type Key = (String, u32);

#[derive(Default)]
struct Table {
    /// Tâche de chaque requête, avec son numéro de lancement : une tâche ne retire que sa propre entrée.
    tasks: HashMap<Key, (u64, tauri::async_runtime::JoinHandle<()>)>,
    /// `net_cancel` arrivés avant l'enregistrement de leur requête (commandes IPC traitées en parallèle).
    marks: HashSet<Key>,
    launched: u64,
}

impl Requests {
    fn table(&self) -> std::sync::MutexGuard<'_, Table> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Deserialize)]
struct NetMeta {
    id: u32,
    target: NetTarget,
    method: String,
    headers: Vec<(String, String)>,
    channel: String,
}

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum NetTarget {
    Gateway { path: String },
    Http { url: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetHead {
    pub(crate) status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
}

pub(crate) struct Opened {
    pub head: NetHead,
    pub body: CoreBody,
}

#[tauri::command]
pub async fn net_fetch(
    webview: Webview,
    core: tauri::State<'_, Core>,
    request: Request<'_>,
) -> Result<NetHead, String> {
    let meta = request
        .headers()
        .get("x-voxel-net")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()
        })
        .and_then(|text| serde_json::from_str::<NetMeta>(&text).ok())
        .ok_or_else(|| "bad request".to_string())?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => Bytes::copy_from_slice(bytes),
        _ => Bytes::new(),
    };
    let channel = JavaScriptChannelId::from_str(&meta.channel)
        .map_err(|error| error.to_string())?
        .channel_on::<_, InvokeResponseBody>(webview.clone());
    let key = (webview.label().to_string(), meta.id);
    let app = webview.app_handle().clone();
    let (head, headed) = tokio::sync::oneshot::channel::<Result<NetHead, String>>();
    {
        // Enregistrée avant tout `.await` : un `net_cancel` reçu avant la tête l'atteint.
        let mut table = core.requests.table();
        if table.marks.remove(&key) {
            return Err("cancelled".to_string());
        }
        table.launched += 1;
        let launched = table.launched;
        let task = tauri::async_runtime::spawn({
            let key = key.clone();
            async move {
                let core = app.state::<Core>();
                match open(&core, meta.target, &meta.method, meta.headers, body).await {
                    Ok(opened) => {
                        let _ = head.send(Ok(opened.head));
                        pump(&channel, opened.body).await;
                    }
                    Err(error) => {
                        let _ = head.send(Err(error));
                    }
                }
                let mut table = core.requests.table();
                if table.tasks.get(&key).is_some_and(|(n, _)| *n == launched) {
                    table.tasks.remove(&key);
                }
            }
        });
        // Les `id` repartent à 1 après un rechargement : l'ancienne tâche d'une clé reprise s'arrête.
        if let Some((_, old)) = table.tasks.insert(key, (launched, task)) {
            old.abort();
        }
    }
    headed
        .await
        .unwrap_or_else(|_| Err("cancelled".to_string()))
}

#[tauri::command]
pub fn net_cancel(webview: Webview, core: tauri::State<'_, Core>, id: u32) {
    let key = (webview.label().to_string(), id);
    let mut table = core.requests.table();
    match table.tasks.remove(&key) {
        Some((_, task)) => task.abort(),
        None => {
            table.marks.insert(key);
        }
    }
}

pub(crate) async fn open(
    core: &Core,
    target: NetTarget,
    method: &str,
    headers: Vec<(String, String)>,
    body: Bytes,
) -> Result<Opened, String> {
    let headers: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(name, _)| !skipped(REQUEST_SKIPPED, name))
        .collect();
    let method = http::Method::from_bytes(method.as_bytes()).map_err(|_| "bad method")?;
    match target {
        NetTarget::Gateway { path } => {
            if !path.starts_with("/imap/") {
                return Err("unknown route".to_string());
            }
            let mut map = http::HeaderMap::new();
            for (name, value) in headers {
                let name =
                    http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| "bad header")?;
                let value = http::HeaderValue::from_str(&value).map_err(|_| "bad header")?;
                map.append(name, value);
            }
            let response = core
                .gateway
                .handle(CoreRequest {
                    method,
                    path,
                    headers: map,
                    body,
                })
                .await;
            let status_text = http::StatusCode::from_u16(response.status)
                .ok()
                .and_then(|status| status.canonical_reason())
                .unwrap_or("")
                .to_string();
            Ok(Opened {
                head: NetHead {
                    status: response.status,
                    status_text,
                    headers: response_headers(response.headers),
                },
                body: response.body,
            })
        }
        NetTarget::Http { url } => {
            let parsed = url::Url::parse(&url).map_err(|_| "bad url")?;
            check_url(&parsed).map_err(|error| error.to_string())?;
            // Sans délai global : flux SSE et gros téléchargements.
            let response = core
                .http
                .fetch(
                    HttpRequest {
                        method,
                        url,
                        headers,
                        body,
                    },
                    FetchOptions::default(),
                )
                .await
                .map_err(|error| error.to_string())?;
            let head = NetHead {
                status: response.status,
                status_text: response.status_text.clone(),
                headers: response_headers(response.headers.clone()),
            };
            Ok(Opened {
                head,
                body: CoreBody::Stream(response.into_stream()),
            })
        }
    }
}

pub(crate) fn cancel_all(app: &AppHandle, label: &str) {
    let Some(core) = app.try_state::<Core>() else {
        return;
    };
    let mut table = core.requests.table();
    table.tasks.retain(|(owner, _), (_, task)| {
        if owner == label {
            task.abort();
            false
        } else {
            true
        }
    });
    table.marks.retain(|(owner, _)| owner != label);
}

fn skipped(list: &[&str], name: &str) -> bool {
    list.iter().any(|skip| name.eq_ignore_ascii_case(skip))
}

fn response_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(name, _)| !skipped(RESPONSE_SKIPPED, name))
        .collect()
}

/// Envoie le corps sur le canal : octets bruts regroupés, puis `{end}` ou `{error}`. Un envoi refusé (vue fermée) arrête tout.
async fn pump(channel: &Channel<InvokeResponseBody>, body: CoreBody) {
    let raw = |bytes: Vec<u8>| channel.send(InvokeResponseBody::Raw(bytes)).is_ok();
    match body {
        CoreBody::Full(bytes) => {
            if !bytes.is_empty() && !raw(bytes.to_vec()) {
                return;
            }
        }
        CoreBody::Stream(mut stream) => {
            let mut buffer = Vec::new();
            loop {
                let item = match stream.next().now_or_never() {
                    Some(item) => item,
                    None => {
                        // Plus rien d'immédiatement disponible : ce qui attend part sans délai (push SSE).
                        if !buffer.is_empty() && !raw(std::mem::take(&mut buffer)) {
                            return;
                        }
                        stream.next().await
                    }
                };
                match item {
                    Some(Ok(chunk)) => {
                        buffer.extend_from_slice(&chunk);
                        if buffer.len() >= CHUNK && !raw(std::mem::take(&mut buffer)) {
                            return;
                        }
                    }
                    Some(Err(error)) => {
                        if !buffer.is_empty() && !raw(std::mem::take(&mut buffer)) {
                            return;
                        }
                        let end = serde_json::json!({ "error": error });
                        let _ = channel.send(InvokeResponseBody::Json(end.to_string()));
                        return;
                    }
                    None => {
                        if !buffer.is_empty() && !raw(std::mem::take(&mut buffer)) {
                            return;
                        }
                        break;
                    }
                }
            }
        }
    }
    let end = serde_json::json!({ "end": true });
    let _ = channel.send(InvokeResponseBody::Json(end.to_string()));
}
