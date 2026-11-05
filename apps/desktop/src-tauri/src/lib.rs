//! Voxel sur le bureau : une fenêtre native affiche l'interface d'apps/web et lui donne, par des commandes Tauri, un cœur Rust local — la passerelle IMAP/SMTP → JMAP, ManageSieve, CardDAV, CalDAV et l'accès JMAP sans CORS. Aucun port n'est ouvert : seule la vue de l'appli atteint ce cœur.

mod factory;
mod files;
mod net;
#[cfg(debug_assertions)]
mod selftest; // jamais compilé dans l'appli publiée (profil release) : rien ne peut y déclencher l'auto-test
mod system;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use voxel_core::dns::SystemDns;
use voxel_core::kv::KvDatabase;
use voxel_core::net::HttpClient;
use voxel_gateway::Gateway;

/// Étiquette de la fenêtre et de la vue de l'interface, la seule à qui la capability « main » donne des droits.
pub(crate) const MAIN: &str = "main";
/// Âge au-delà duquel une entrée de `imap-kv.sqlite` est purgée au démarrage, comme `purgeOldKv` de Node.
const KV_MAX_AGE: Duration = Duration::from_secs(180 * 24 * 60 * 60);
/// wry injecte l'IPC de Tauri dans toutes les iframes, C10 : on coupe ses transports dans tout cadre qui n'est pas le cadre principal (`window.chrome` sous WebView2, `window.webkit` sous WebKitGTK).
const FRAME_GUARD: &str = r#"(function () {
  if (window.top === window) return;
  var f = window.fetch;
  var guarded = function (input, init) {
    var u = String((input && input.url) || input);
    if (/^ipc:|^https?:\/\/ipc\.localhost/i.test(u)) return Promise.reject(new TypeError('IPC disabled in frames'));
    return f.apply(this, arguments);
  };
  try { Object.defineProperty(window, 'fetch', { value: guarded, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(window, 'chrome', { value: undefined, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(window, 'webkit', { value: undefined, writable: false, configurable: false }); } catch (e) {}
})();"#;

pub(crate) struct Core {
    pub gateway: Arc<Gateway>,
    pub http: HttpClient,
    pub requests: net::Requests,
}

pub fn run() {
    // La variable est ignorée par l'appli publiée.
    #[cfg(debug_assertions)]
    let selftest = std::env::var("VOXEL_DESKTOP_SELFTEST").ok();
    #[cfg(not(debug_assertions))]
    let selftest: Option<String> = None;

    let mut builder = tauri::Builder::default();
    // L'auto-test a son propre profil : il ne doit pas se rabattre sur une fenêtre déjà ouverte.
    if selftest.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window(MAIN) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            net::net_fetch,
            net::net_cancel,
            files::file_save,
            files::file_download,
            system::open_external,
            system::notify,
            system::device_key,
            system::desktop_info
        ])
        .setup(move |app| {
            app.manage(system::SelftestMode(selftest.is_some()));
            let folder = match &selftest {
                Some(folder) => PathBuf::from(folder).join("core"),
                None => app.path().app_local_data_dir()?.join("core"),
            };
            std::fs::create_dir_all(&folder)?;
            let kv = KvDatabase::open(&folder.join("imap-kv.sqlite"))?;
            kv.purge_older_than(KV_MAX_AGE);
            let http = HttpClient::new()?;
            let dns = SystemDns::new()?;
            let factory = Arc::new(factory::DesktopFactory::new(
                folder.join("blobs"),
                http.clone(),
            ));
            let gateway = Gateway::new(
                factory,
                Arc::new(move |key: &str| kv.store(key)),
                http.clone(),
                Arc::new(dns),
            );
            app.manage(Core {
                gateway,
                http,
                requests: net::Requests::default(),
            });
            app.manage(system::Notified::default());

            let mut window =
                WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                    .title("Voxel")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(800.0, 560.0)
                    .use_https_scheme(false)
                    .disable_drag_drop_handler()
                    .initialization_script_for_all_frames(FRAME_GUARD)
                    .on_new_window(|url, _| {
                        system::open_outside(&url);
                        NewWindowResponse::Deny
                    })
                    .on_navigation(system::allowed_navigation)
                    .on_document_title_changed(|window, title| {
                        let _ = window.set_title(if title.trim().is_empty() {
                            "Voxel"
                        } else {
                            &title
                        });
                    })
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), PageLoadEvent::Started) {
                            net::cancel_all(window.app_handle(), MAIN)
                        }
                    });
            if let Some(folder) = &selftest {
                window = window.data_directory(PathBuf::from(folder).join("profile"));
            }
            window.build()?;

            #[cfg(debug_assertions)]
            if let Some(folder) = selftest.clone() {
                selftest::run(app.handle().clone(), folder)
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("l'application n'a pas pu démarrer");
    app.run(|app, event| {
        // Fermeture propre des connexions IMAP.
        if let RunEvent::Exit = event {
            let core = app.state::<Core>();
            tauri::async_runtime::block_on(core.gateway.close());
        }
    });
}
