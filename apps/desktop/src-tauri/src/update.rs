//! Mises à jour de Voxel depuis les releases GitHub : `latest.json` de la dernière release donne la version et, pour chaque installeur (NSIS sous Windows, AppImage, .deb ou .rpm sous Linux), son adresse et sa signature. Le greffon updater n'installe qu'un fichier signé par la clé de Voxel (clé publique dans `tauri.conf.json`, clé privée dans les secrets du dépôt). L'interface n'a que deux commandes : chercher une mise à jour, l'installer puis redémarrer. Un binaire de développement ou l'auto-test n'en cherche jamais : la release remplacerait le binaire en cours de test.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::MAIN;
use crate::system::SelftestMode;

/// Délai d'une recherche (lecture de `latest.json`).
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Avancement du téléchargement, envoyé à l'interface.
const PROGRESS_EVENT: &str = "voxel:update-progress";

/// Mise à jour trouvée par la dernière recherche, en attente d'installation.
#[derive(Default)]
pub(crate) struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Les mises à jour ne concernent que l'appli publiée, hors auto-test.
fn enabled(selftest: bool) -> bool {
    !cfg!(debug_assertions) && !selftest
}

/// Sous Linux, seule une appli installée par un paquet connu (AppImage, .deb, .rpm) sait se remplacer.
fn installable() -> bool {
    !cfg!(target_os = "linux") || tauri::utils::platform::bundle_type().is_some()
}

/// Cherche une version plus récente ; `None` si Voxel est à jour (ou dans un binaire de développement).
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    mode: State<'_, SelftestMode>,
) -> Result<Option<UpdateInfo>, String> {
    if !enabled(mode.0) || !installable() {
        return Ok(None);
    }
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    });
    *pending.0.lock().map_err(|error| error.to_string())? = update;
    Ok(info)
}

/// Télécharge et installe la mise à jour trouvée, puis relance Voxel. Sous Windows, l'installeur ferme l'appli et la rouvre lui-même.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or_else(|| "Aucune mise à jour en attente.".to_string())?;
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit_to(MAIN, PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_in_selftest() {
        assert!(!enabled(true));
    }

    #[test]
    fn never_in_development_builds() {
        // les tests tournent en debug : la recherche doit y être coupée
        assert_eq!(enabled(false), !cfg!(debug_assertions));
    }
}
