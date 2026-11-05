//! Enregistrements sur le disque : toute sauvegarde passe par « Enregistrer sous » natif, et une pièce jointe est téléchargée par le cœur directement dans le fichier choisi, sans copie en mémoire côté interface. Écriture à côté puis renommage, comme `write_atomic` du studio IL.

use std::path::{Path, PathBuf};

use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use voxel_core::http::CoreBody;

use crate::Core;
use crate::net::{self, NetTarget};

/// Longueur maximale d'un nom de fichier proposé, en caractères.
const MAX_NAME: usize = 120;
/// Noms que Windows réserve à ses périphériques.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3",
];

#[derive(Serialize)]
pub(crate) struct Saved {
    saved: bool,
}

#[tauri::command]
pub async fn file_save(app: AppHandle, request: Request<'_>) -> Result<Saved, String> {
    let name = request
        .headers()
        .get("x-voxel-file")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()
        })
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|meta| meta["name"].as_str().map(str::to_string))
        .ok_or_else(|| "bad request".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => Vec::new(),
    };
    let Some(path) = ask_path(&app, &name).await else {
        return Ok(Saved { saved: false });
    };
    let part = part_of(&path);
    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Saved { saved: true })
}

#[tauri::command]
pub async fn file_download(
    app: AppHandle,
    core: tauri::State<'_, Core>,
    name: String,
    target: NetTarget,
    headers: Vec<(String, String)>,
) -> Result<Saved, String> {
    let Some(path) = ask_path(&app, &name).await else {
        return Ok(Saved { saved: false });
    };
    download_to(&core, target, headers, &path).await?;
    Ok(Saved { saved: true })
}

pub(crate) async fn download_to(
    core: &Core,
    target: NetTarget,
    headers: Vec<(String, String)>,
    path: &Path,
) -> Result<u64, String> {
    let opened = net::open(core, target, "GET", headers, Bytes::new()).await?;
    let status = opened.head.status;
    if !(200..300).contains(&status) {
        return Err(format!("download failed (HTTP {status})"));
    }
    let part = part_of(path);
    let written = write_body(&part, opened.body).await;
    match written {
        Ok(size) => {
            tokio::fs::rename(&part, path)
                .await
                .map_err(|error| error.to_string())?;
            Ok(size)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(error)
        }
    }
}

async fn write_body(part: &Path, body: CoreBody) -> Result<u64, String> {
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|error| error.to_string())?;
    let mut size = 0u64;
    match body {
        CoreBody::Full(bytes) => {
            file.write_all(&bytes)
                .await
                .map_err(|error| error.to_string())?;
            size = bytes.len() as u64;
        }
        CoreBody::Stream(mut stream) => {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk)
                    .await
                    .map_err(|error| error.to_string())?;
                size += chunk.len() as u64;
            }
        }
    }
    file.flush().await.map_err(|error| error.to_string())?;
    Ok(size)
}

fn part_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', ' '])
        .to_string();
    match cleaned.as_str() {
        "" => "fichier".to_string(),
        name if RESERVED.contains(&name.to_uppercase().as_str()) => format!("{name}-1"),
        _ => cleaned.chars().take(MAX_NAME).collect(),
    }
}

/// « Enregistrer sous », sans bloquer le fil principal ; `None` si l'utilisateur annule.
async fn ask_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(safe_name(name))
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    receiver.await.ok().flatten()?.into_path().ok()
}
