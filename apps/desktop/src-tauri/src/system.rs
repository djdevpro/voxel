//! Ce que la page ne peut pas faire seule sur le bureau : ouvrir un lien dans le navigateur du système, montrer une notification native, garder la clé d'appareil dans le coffre du système. La vue ne quitte jamais l'appli : toute autre adresse part dans le navigateur.

use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Service des entrées du coffre du système (Gestionnaire d'identifiants Windows).
pub(crate) const VAULT_SERVICE: &str = "dev.voxel.desktop";
/// Compte de la clé d'appareil de l'appli.
const DEVICE_KEY: &str = "device-key";
/// Compte de la clé d'appareil de l'auto-test, à part de la vraie, supprimé à la fin de la phase `resume`.
pub(crate) const SELFTEST_DEVICE_KEY: &str = "device-key-selftest";
/// Taille de la clé AES-GCM de l'interface, en octets.
const KEY_SIZE: usize = 32;
/// Hôte des fichiers de l'appli (`use_https_scheme(false)`).
const APP_HOST: &str = "tauri.localhost";
/// Origine du serveur Vite de développement (`devUrl`).
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:5373";

/// Notifications montrées (lu par l'auto-test).
#[derive(Default)]
pub(crate) struct Notified(pub(crate) AtomicUsize);

/// Vrai seulement dans un binaire de débogage lancé avec VOXEL_DESKTOP_SELFTEST.
pub(crate) struct SelftestMode(pub bool);

#[derive(Serialize)]
pub(crate) struct DesktopInfo {
    version: String,
    selftest: bool,
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let refused = || "Seuls les liens http et https s'ouvrent dans le navigateur.".to_string();
    let url = url::Url::parse(&url).map_err(|_| refused())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(refused());
    }
    open_outside(&url);
    Ok(())
}

#[tauri::command]
pub fn notify(
    app: AppHandle,
    notified: tauri::State<'_, Notified>,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())?;
    notified.0.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn device_key(mode: tauri::State<'_, SelftestMode>) -> Result<String, String> {
    let unavailable = || "Le coffre du système est indisponible.".to_string();
    let account = if mode.0 {
        SELFTEST_DEVICE_KEY
    } else {
        DEVICE_KEY
    };
    let entry = keyring::Entry::new(VAULT_SERVICE, account).map_err(|_| unavailable())?;
    let key = match entry.get_secret() {
        Ok(key) => key,
        Err(keyring::Error::NoEntry) => {
            let mut key = vec![0u8; KEY_SIZE];
            getrandom::fill(&mut key).map_err(|_| unavailable())?;
            entry.set_secret(&key).map_err(|_| unavailable())?;
            key
        }
        Err(_) => return Err(unavailable()),
    };
    Ok(base64::engine::general_purpose::STANDARD.encode(key))
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, mode: tauri::State<'_, SelftestMode>) -> DesktopInfo {
    DesktopInfo {
        version: app.package_info().version.to_string(),
        selftest: mode.0,
    }
}

pub(crate) fn open_outside(url: &url::Url) {
    if !matches!(url.scheme(), "http" | "https") || is_app(url) {
        return;
    }
    launch(url.as_str());
}

pub(crate) fn allowed_navigation(url: &url::Url) -> bool {
    if url.as_str() == "about:blank" || is_app(url) || url.as_str().starts_with("tauri://localhost")
    {
        return true;
    }
    open_outside(url);
    false
}

/// L'appli elle-même : `http://tauri.localhost` et, en debug, l'origine du `devUrl`.
fn is_app(url: &url::Url) -> bool {
    if url.scheme() == "http" && url.host_str() == Some(APP_HOST) {
        return true;
    }
    #[cfg(debug_assertions)]
    if url.origin().ascii_serialization() == DEV_ORIGIN {
        return true;
    }
    false
}

#[cfg(windows)]
fn launch(url: &str) {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR, w};

    let target = HSTRING::from(url);
    unsafe {
        let _ = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(target_os = "macos")]
fn launch(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

#[cfg(not(any(windows, target_os = "macos")))]
fn launch(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}
