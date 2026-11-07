//! Ouverture de Voxel avec la session, fenêtre cachée (`--background`) : l'appli vit dans la zone de notification et garde synchronisation et notifications. Activée une fois au premier lancement de l'appli publiée, ensuite réglée par l'utilisateur. Un binaire de développement ne s'inscrit jamais tout seul, et l'auto-test n'y touche jamais.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::system::SelftestMode;

/// Argument des lancements avec la session : la fenêtre reste cachée.
pub(crate) const BACKGROUND_ARG: &str = "--background";
/// Témoin, dans le dossier local de l'appli, de l'activation faite au premier lancement.
#[cfg(not(debug_assertions))]
const FIRST_RUN_MARKER: &str = "autostart-initialized";
/// Entrée de démarrage d'un binaire de développement, à part de celle de l'appli installée.
#[cfg(debug_assertions)]
const DEV_NAME: &str = "Voxel Dev";

/// Réglage de l'auto-test, en mémoire seulement.
static SELFTEST_ENABLED: AtomicBool = AtomicBool::new(false);

/// Greffon d'ouverture avec la session : l'entrée lance Voxel avec `--background`.
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri_plugin_autostart::Builder::new().arg(BACKGROUND_ARG);
    // Activer l'ouverture depuis `tauri dev` ne remplace pas l'entrée de l'appli installée.
    #[cfg(debug_assertions)]
    let builder = builder.app_name(DEV_NAME);
    builder.build()
}

/// Premier lancement de l'appli publiée : Voxel s'ouvrira avec la session. Ensuite seul le choix de l'utilisateur compte, même désactivé. Jamais compilé en debug : l'entrée pointerait vers un binaire du dossier `target`.
#[cfg(not(debug_assertions))]
pub(crate) fn first_run(app: &AppHandle) {
    use tauri::Manager;

    let folder = match app.path().app_local_data_dir() {
        Ok(folder) => folder,
        Err(error) => {
            voxel_core::log::warn(format!("autostart: {error}"));
            return;
        }
    };
    let marker = folder.join(FIRST_RUN_MARKER);
    if marker.exists() {
        return;
    }
    // En cas d'échec, sans témoin : nouvel essai au prochain lancement.
    if let Err(error) = app.autolaunch().enable() {
        voxel_core::log::warn(format!("autostart: {error}"));
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(&marker, b""))
    {
        voxel_core::log::warn(format!("autostart: {error}"));
    }
}

/// Ouverture avec la session activée ? L'auto-test lit sa valeur en mémoire.
#[tauri::command]
pub fn autostart_get(app: AppHandle, mode: State<'_, SelftestMode>) -> Result<bool, String> {
    if mode.0 {
        return Ok(SELFTEST_ENABLED.load(Ordering::SeqCst));
    }
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

/// Active ou désactive l'ouverture avec la session ; l'auto-test ne change que sa valeur en mémoire.
#[tauri::command]
pub fn autostart_set(
    app: AppHandle,
    mode: State<'_, SelftestMode>,
    enabled: bool,
) -> Result<(), String> {
    if mode.0 {
        SELFTEST_ENABLED.store(enabled, Ordering::SeqCst);
        return Ok(());
    }
    let autostart = app.autolaunch();
    let done = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    done.map_err(|error| error.to_string())
}
