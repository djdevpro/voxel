//! Captures de l'auto-test : WebView2 dessine lui-même la page par son protocole DevTools (`Page.captureScreenshot`), comme `engine/devtools.rs` du studio IL. Ailleurs que sous Windows, pas de capture.

#[cfg(windows)]
pub(crate) async fn png(view: &tauri::Webview) -> Result<Vec<u8>, String> {
    use base64::Engine;

    let reply: serde_json::Value = serde_json::from_str(
        &call(
            view,
            "Page.captureScreenshot",
            r#"{"format":"png"}"#.to_string(),
        )
        .await?,
    )
    .map_err(|error| error.to_string())?;
    let data = reply["data"]
        .as_str()
        .ok_or_else(|| "capture vide".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) async fn png(_view: &tauri::Webview) -> Result<Vec<u8>, String> {
    Err("captures disponibles sous Windows seulement".to_string())
}

/// Appelle une méthode DevTools et rend son résultat JSON.
#[cfg(windows)]
async fn call(view: &tauri::Webview, method: &str, params: String) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let reply = move |result: Result<String, String>| {
        if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = sender.send(result);
        }
    };
    let method = HSTRING::from(method);
    let params = HSTRING::from(params);
    view.with_webview(move |platform| {
        let done = reply.clone();
        let call = || -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, json| {
                        done(status.map(|_| json).map_err(|error| error.message()));
                        Ok(())
                    },
                ));
                core.CallDevToolsProtocolMethod(
                    PCWSTR(method.as_ptr()),
                    PCWSTR(params.as_ptr()),
                    &handler,
                )
            }
        };
        if let Err(error) = call() {
            reply(Err(error.message()));
        }
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "WebView2 n'a pas répondu".to_string())?
}
