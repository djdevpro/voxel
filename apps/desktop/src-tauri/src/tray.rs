//! Icône de Voxel dans la zone de notification. Fenêtre fermée, l'appli y reste (synchronisation, notifications) ; l'icône porte la pastille des non-lus, comme le bouton de la barre des tâches. Clic gauche ou « Ouvrir Voxel » : la fenêtre revient ; « Quitter Voxel » : l'interface envoie ses messages en attente puis ferme l'appli.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::MAIN;
use crate::badge::{self, Rgba};

/// Identifiant de l'icône.
const TRAY: &str = "main";
/// Entrées du menu (les identifiants des menus sont communs à toute l'appli).
const OPEN_ITEM: &str = "tray-open";
const QUIT_ITEM: &str = "tray-quit";
/// Libellés en attendant ceux de l'interface (`set_tray_labels`).
const OPEN_LABEL: &str = "Open Voxel";
const QUIT_LABEL: &str = "Quit Voxel";
/// Demande à l'interface de quitter : elle envoie les messages en attente puis détruit sa fenêtre, ce qui ferme l'appli.
const QUIT_EVENT: &str = "voxel:quit";
/// Au-delà, l'appli se ferme sans attendre l'interface.
const QUIT_GRACE: Duration = Duration::from_secs(5);
/// Info-bulle par défaut.
const NAME: &str = "Voxel";
/// Longueur maximale de l'info-bulle, en caractères : Windows en garde 127 unités UTF-16.
const TOOLTIP_MAX: usize = 63;

/// Dernier nombre de non-lus et icône de la zone de notification sans pastille.
pub(crate) struct Badge {
    base: Option<Rgba>,
    count: AtomicU32,
}

/// Entrées du menu de l'icône, renommées dans la langue de l'interface.
pub(crate) struct TrayMenu {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// Crée l'icône de la zone de notification ; `false` si le système n'en offre pas.
pub(crate) fn install(app: &AppHandle) -> bool {
    let base = app.default_window_icon().map(|icon| {
        let icon = Rgba {
            width: icon.width(),
            height: icon.height(),
            pixels: icon.rgba().to_vec(),
        };
        badge::shrink(&icon, badge::TRAY_MAX)
    });
    app.manage(Badge {
        base: base.clone(),
        count: AtomicU32::new(0),
    });
    let Some(base) = base else {
        voxel_core::log::warn("tray: no icon");
        return false;
    };
    // Sous Linux, tray-icon panique si libayatana-appindicator manque : Voxel continue sans icône.
    match std::panic::catch_unwind(AssertUnwindSafe(|| build(app, base))) {
        Ok(Ok(menu)) => {
            app.manage(menu);
            true
        }
        Ok(Err(error)) => {
            voxel_core::log::warn(format!("tray: {error}"));
            false
        }
        Err(_) => {
            voxel_core::log::warn("tray: unavailable");
            false
        }
    }
}

fn build(app: &AppHandle, base: Rgba) -> tauri::Result<TrayMenu> {
    let open_item = MenuItem::with_id(app, OPEN_ITEM, OPEN_LABEL, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_ITEM, QUIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
    TrayIconBuilder::with_id(TRAY)
        .icon(image(base))
        .tooltip(NAME)
        .menu(&menu)
        // Clic gauche : la fenêtre ; le menu au clic droit. Sous Linux, seul le menu existe.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ITEM => show_main(app),
            QUIT_ITEM => quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(TrayMenu {
        open: open_item,
        quit: quit_item,
    })
}

/// Ramène la fenêtre : montrée, restaurée, au premier plan.
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// « Quitter Voxel » : l'interface ferme l'appli ; si sa fenêtre est encore là après `QUIT_GRACE`, l'appli se ferme seule.
fn quit(app: &AppHandle) {
    if app.get_webview_window(MAIN).is_none() {
        app.exit(0);
        return;
    }
    let _ = app.emit_to(MAIN, QUIT_EVENT, ());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIT_GRACE).await;
        if app.get_webview_window(MAIN).is_some() {
            app.exit(0);
        }
    });
}

fn image(rgba: Rgba) -> Image<'static> {
    Image::new_owned(rgba.pixels, rgba.width, rgba.height)
}

/// Info-bulle de l'icône : le texte de l'interface, « Voxel » s'il est vide.
fn tooltip_text(tooltip: &str) -> String {
    let text = tooltip.trim();
    if text.is_empty() {
        NAME.to_string()
    } else {
        text.chars().take(TOOLTIP_MAX).collect()
    }
}

/// Pastille des non-lus : bouton de la barre des tâches (icône de superposition sous Windows, compteur du lanceur ailleurs) et icône de la zone de notification, avec son info-bulle.
#[tauri::command]
pub fn set_badge(
    app: AppHandle,
    state: State<'_, Badge>,
    count: u32,
    tooltip: String,
) -> Result<(), String> {
    state.count.store(count, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(MAIN) {
        // Fenêtre cachée : sans bouton, Windows ignore la pastille ; `taskbar` la repose au retour.
        #[cfg(windows)]
        let _ = window.set_overlay_icon(badge::overlay(count).map(image));
        // Non pris en charge partout (Linux : seulement avec libunity) : sans effet alors.
        #[cfg(not(windows))]
        let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
    }
    if let (Some(tray), Some(base)) = (app.tray_by_id(TRAY), &state.base) {
        tray.set_icon(Some(image(badge::tray(base, count))))
            .map_err(|error| error.to_string())?;
        tray.set_tooltip(Some(tooltip_text(&tooltip)))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Libellés du menu de l'icône, dans la langue de l'interface ; un libellé vide garde le précédent.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, open: String, quit: String) -> Result<(), String> {
    // Sans icône, rien à renommer.
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return Ok(());
    };
    for (item, text) in [(&menu.open, open), (&menu.quit, quit)] {
        if !text.trim().is_empty() {
            item.set_text(text.trim())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Windows retire le bouton de la barre des tâches d'une fenêtre cachée, et sa pastille avec : quand l'Explorateur le recrée (retour de la fenêtre, redémarrage de l'Explorateur), la pastille est reposée.
#[cfg(windows)]
pub(crate) fn keep_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        taskbar::watch(&window);
    }
}

#[cfg(windows)]
mod taskbar {
    use std::sync::OnceLock;
    use std::sync::atomic::Ordering;

    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        ChangeWindowMessageFilterEx, MSGFLT_ALLOW, RegisterWindowMessageW, WM_NCDESTROY,
    };
    use windows::core::w;

    use super::{Badge, image};
    use crate::{MAIN, badge};

    /// Identifiant de la sous-classe de la fenêtre, à côté de celle de tao.
    const SUBCLASS_ID: usize = 0x766F_786C;
    /// Message `TaskbarButtonCreated` de l'Explorateur.
    static BUTTON_CREATED: OnceLock<u32> = OnceLock::new();
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub(super) fn watch(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let message = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
        if message == 0 {
            return;
        }
        let _ = BUTTON_CREATED.set(message);
        let _ = APP.set(window.app_handle().clone());
        unsafe {
            // Lancée en administrateur, la fenêtre accepte quand même le message de l'Explorateur.
            let _ = ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None);
            let _ = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0);
        }
    }

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if BUTTON_CREATED.get() == Some(&message)
            && let Some(app) = APP.get()
        {
            // Hors de la procédure de la fenêtre : la pastille part vers l'Explorateur après ce message.
            let app = app.clone();
            tauri::async_runtime::spawn(async move { restore(&app) });
        } else if message == WM_NCDESTROY {
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID);
            }
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    fn restore(app: &AppHandle) {
        let count = app
            .try_state::<Badge>()
            .map_or(0, |state| state.count.load(Ordering::SeqCst));
        if count > 0
            && let Some(window) = app.get_webview_window(MAIN)
        {
            let _ = window.set_overlay_icon(badge::overlay(count).map(image));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_defaults_to_the_app_name() {
        assert_eq!(tooltip_text(""), "Voxel");
        assert_eq!(tooltip_text("   "), "Voxel");
        assert_eq!(tooltip_text(" Voxel — 3 non lus "), "Voxel — 3 non lus");
    }

    #[test]
    fn tooltip_fits_the_windows_limit() {
        let long = "é".repeat(500);
        let text = tooltip_text(&long);
        assert_eq!(text.chars().count(), TOOLTIP_MAX);
        assert!(text.encode_utf16().count() < 128);
    }
}
