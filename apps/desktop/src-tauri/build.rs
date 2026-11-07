fn main() {
    // Les commandes de l'appli ont leurs propres permissions : la capability « main » est la seule à les accorder.
    let commands = &[
        "net_fetch",
        "net_cancel",
        "file_save",
        "file_download",
        "open_external",
        "notify",
        "device_key",
        "desktop_info",
        "set_badge",
        "set_tray_labels",
        "autostart_get",
        "autostart_set",
        "update_check",
        "update_install",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("le contexte Tauri n'a pas pu être construit");
}
