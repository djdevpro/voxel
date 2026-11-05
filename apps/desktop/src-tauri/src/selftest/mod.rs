//! `VOXEL_DESKTOP_SELFTEST=<dossier>` joue le parcours de CA2 sans personne : connexion, dossiers, rédaction, envoi à soi, réception sans recharger, lecture, téléchargement de la pièce jointe sur le disque, recherche, marquage, déplacement, piège HTML, suppression, réglages, fonctions montrées selon les capacités du serveur ; une capture PNG par écran et `report.txt` dans ce dossier, puis l'appli se ferme. `VOXEL_DESKTOP_SELFTEST_PHASE=resume` relance sur le même dossier et vérifie que la boîte et les réglages ont survécu, puis nettoie. Profil, données et entrée de coffre de l'auto-test sont à part. Module compilé seulement avec `debug_assertions` : `tauri dev`, ou `tauri build --debug` pour vérifier le frontend de production ; jamais dans l'appli publiée.

mod screenshot;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::net::NetTarget;
use crate::system::{Notified, SELFTEST_DEVICE_KEY, VAULT_SERVICE};
use crate::{Core, MAIN, files};

/// Délai laissé à l'interface pour poser ses écouteurs (un premier lancement peut recharger pendant que Vite prépare).
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// Délai d'une étape.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);
/// Délai de l'étape `receive` : l'arrivée du message dépend du serveur.
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(120);
/// Attente donnée à la page pour `receive`, sous le délai de Rust pour que la page réponde la première.
const RECEIVE_WAIT_MS: u64 = 110_000;
/// Nom de la pièce jointe envoyée puis téléchargée.
const ATTACHMENT_NAME: &str = "voxel-selftest.txt";
/// Taille de la pièce jointe, en octets.
const ATTACHMENT_SIZE: usize = 2_048;
/// Origine du frontend de production : protocole d'assets en `http://tauri.localhost` sous WebView2 (`use_https_scheme(false)`), `tauri://localhost` ailleurs.
const APP_ORIGIN: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};
/// Fichier des identifiants de la boîte de test, cherché en remontant depuis le dossier courant.
const ENV_FILE: &str = ".env.test.local";

struct Credentials {
    user: String,
    password: String,
    /// Serveur choisi, sans découverte.
    session_url: Option<String>,
    /// URL de session connue de la boîte de test, comparée à celle que trouve la découverte.
    expected_url: Option<String>,
}

struct Done {
    ok: bool,
    detail: String,
    data: Value,
}

impl Done {
    fn failed(detail: &str) -> Self {
        Self {
            ok: false,
            detail: detail.to_string(),
            data: Value::Null,
        }
    }
}

struct Runner {
    app: AppHandle,
    folder: PathBuf,
    done: UnboundedReceiver<(u64, Done)>,
    next_id: u64,
    lines: Vec<String>,
    failed: bool,
}

pub(crate) fn run(app: AppHandle, folder: String) {
    // Écouteurs posés avant le chargement de la page.
    let (ready, listening) = tokio::sync::oneshot::channel::<()>();
    let ready = std::sync::Mutex::new(Some(ready));
    app.once("selftest:ready", move |_| {
        if let Some(ready) = ready.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = ready.send(());
        }
    });
    let (sender, done) = tokio::sync::mpsc::unbounded_channel();
    app.listen("selftest:done", move |event| {
        let Ok(reply) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let Some(id) = reply["id"].as_u64() else {
            return;
        };
        let _ = sender.send((
            id,
            Done {
                ok: reply["ok"].as_bool().unwrap_or(false),
                detail: reply["detail"].as_str().unwrap_or("").to_string(),
                data: reply.get("data").cloned().unwrap_or(Value::Null),
            },
        ));
    });
    tauri::async_runtime::spawn(async move {
        let resume = std::env::var("VOXEL_DESKTOP_SELFTEST_PHASE").as_deref() == Ok("resume");
        let mut runner = Runner {
            app: app.clone(),
            folder: PathBuf::from(&folder),
            done,
            next_id: 0,
            lines: Vec::new(),
            failed: false,
        };
        let started = Instant::now();
        let waited = tokio::time::timeout(READY_TIMEOUT, listening).await;
        runner.line(
            "ready",
            matches!(waited, Ok(Ok(()))),
            started,
            "selftest:ready",
        );
        match credentials() {
            Some(credentials) if !runner.failed => {
                runner.environment().await;
                if resume {
                    runner.resume(&credentials).await;
                } else {
                    runner.complete(&credentials).await;
                }
                runner.secrets(&credentials);
            }
            Some(_) => {}
            None => runner.line(
                "credentials",
                false,
                Instant::now(),
                "VOXEL_TEST_USER / VOXEL_TEST_PASSWORD missing",
            ),
        }
        runner.finish();
    });
}

impl Runner {
    fn line(&mut self, name: &str, ok: bool, started: Instant, detail: &str) {
        if !ok {
            self.failed = true;
        }
        let verdict = if ok { "ok" } else { "FAIL" };
        let ms = started.elapsed().as_millis();
        self.lines.push(format!("{name} {verdict} {ms} {detail}"));
    }

    /// Émet `selftest:step` et attend le `selftest:done` du même numéro.
    async fn ask(&mut self, name: &str, args: Value, timeout: Duration) -> Done {
        self.next_id += 1;
        let id = self.next_id;
        let step = json!({ "id": id, "name": name, "args": args });
        if self.app.emit("selftest:step", step).is_err() {
            return Done::failed("emit failed");
        }
        let receiver = &mut self.done;
        let wait = async {
            while let Some((got, done)) = receiver.recv().await {
                if got == id {
                    return Some(done);
                }
            }
            None
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(Some(done)) => done,
            Ok(None) => Done::failed("listener closed"),
            Err(_) => Done::failed("timeout"),
        }
    }

    /// Rend le texte de la capture pour le rapport ; hors Windows, elle est sautée sans compter dans le verdict.
    async fn capture(&self, file: &str) -> Result<String, String> {
        if !cfg!(windows) {
            return Ok("capture skipped (windows only)".to_string());
        }
        let window = self
            .app
            .get_webview_window(MAIN)
            .ok_or_else(|| "vue absente".to_string())?;
        let bytes = screenshot::png(window.as_ref()).await?;
        std::fs::write(self.folder.join(file), bytes).map_err(|error| error.to_string())?;
        Ok(file.to_string())
    }

    /// Une étape de l'interface, sa capture si elle en a une, et sa ligne au rapport. Rend la `data` de l'étape.
    async fn play(
        &mut self,
        name: &str,
        args: Value,
        shot: Option<&str>,
        extra: impl FnOnce(&Value) -> String,
    ) -> Value {
        let started = Instant::now();
        let timeout = if name == "receive" {
            RECEIVE_TIMEOUT
        } else {
            STEP_TIMEOUT
        };
        let done = self.ask(name, args, timeout).await;
        let mut ok = done.ok;
        let mut detail = done.detail;
        let more = extra(&done.data);
        if !more.is_empty() {
            detail = format!("{detail} {more}");
        }
        if let Some(file) = shot {
            match self.capture(file).await {
                Ok(shot) => detail = format!("{detail} {shot}"),
                Err(error) => {
                    ok = false;
                    detail = format!("{detail} capture {file}: {error}");
                }
            }
        }
        self.line(name, ok, started, &detail);
        done.data
    }

    /// Relevés de la page jugés ici : frontend de développement (Vite) ou de production (protocole d'assets).
    async fn environment(&mut self) {
        let started = Instant::now();
        let done = self.ask("environment", json!({}), STEP_TIMEOUT).await;
        if !done.ok {
            self.line("environment", false, started, &done.detail);
            return;
        }
        let data = done.data;
        let production = !tauri::is_dev();
        let origin = data["origin"].as_str().unwrap_or("");
        let csp = data["csp"].as_bool().unwrap_or(false);
        let sw = data["serviceWorkers"].as_u64();
        let config = data["configStatus"].as_u64().unwrap_or(0);
        let mut ok = sw == Some(0);
        if production {
            ok = ok
                && origin == APP_ORIGIN
                && csp
                && data["prod"].as_bool() == Some(true)
                && config == 200
                && data["configOk"].as_bool() == Some(true);
        }
        let kind = if production {
            "production"
        } else {
            "development"
        };
        let sw = sw.map_or("?".to_string(), |n| n.to_string());
        let detail = format!(
            "{kind} origin={origin} csp={csp} sw={sw} config={config} eval={}",
            data["evalAllowed"]
        );
        self.line("environment", ok, started, &detail);
    }

    async fn complete(&mut self, credentials: &Credentials) {
        let started = Instant::now();
        match self.capture("01-login.png").await {
            Ok(shot) => self.line("capture", true, started, &shot),
            Err(error) => self.line("capture", false, started, &format!("01-login.png: {error}")),
        }
        let email = credentials.user.clone();
        let subject = format!("Voxel selftest {}", random_base36(8));
        let attachment = random_base36(ATTACHMENT_SIZE).into_bytes();

        let discovered = credentials.session_url.is_none();
        let expected = credentials.expected_url.clone();
        self.play(
            "login",
            json!({ "email": email, "password": credentials.password, "sessionUrl": credentials.session_url }),
            Some("02-inbox.png"),
            |data| match (discovered, expected, data["sessionUrl"].as_str()) {
                (true, Some(expected), Some(found)) => {
                    format!("discovery same-url {}", expected == found)
                }
                _ => String::new(),
            },
        )
        .await;
        self.play("folders", json!({}), None, |data| {
            format!("count={} roles={}", data["count"], data["roles"])
        })
        .await;
        self.play(
            "compose",
            json!({ "to": email, "subject": subject }),
            Some("03-compose.png"),
            |_| String::new(),
        )
        .await;
        let notified = self.app.state::<Notified>().0.load(Ordering::SeqCst);
        self.play(
            "send",
            json!({
                "to": email,
                "subject": subject,
                "text": "Voxel selftest",
                "attachmentName": ATTACHMENT_NAME,
                "attachmentBase64": base64::engine::general_purpose::STANDARD.encode(&attachment),
            }),
            None,
            |_| String::new(),
        )
        .await;
        let app = self.app.clone();
        self.play(
            "receive",
            json!({ "subject": subject, "timeoutMs": RECEIVE_WAIT_MS }),
            Some("04-received.png"),
            move |data| {
                let shown = app.state::<Notified>().0.load(Ordering::SeqCst) > notified;
                let delay = format!("delay {}ms", data["elapsedMs"]);
                if shown {
                    format!("{delay} notification shown")
                } else {
                    delay
                }
            },
        )
        .await;
        self.listen();
        let opened = self
            .play(
                "open",
                json!({ "subject": subject }),
                Some("05-reader.png"),
                |_| String::new(),
            )
            .await;
        self.download(&opened["attachment"], &attachment).await;
        let email_id = opened["emailId"].clone();
        self.play(
            "search",
            json!({ "subject": subject }),
            Some("06-search.png"),
            |_| String::new(),
        )
        .await;
        self.play(
            "mark",
            json!({ "emailId": email_id }),
            Some("07-mark.png"),
            |_| String::new(),
        )
        .await;
        let moved = self
            .play(
                "move",
                json!({ "emailId": email_id }),
                Some("08-move.png"),
                |data| format!("created={}", data["created"]),
            )
            .await;
        self.trap().await;
        self.play(
            "delete",
            json!({ "emailId": email_id, "mailboxId": moved["mailboxId"], "createdFolder": moved["created"].as_bool().unwrap_or(false) }),
            Some("10-deleted.png"),
            |_| String::new(),
        )
        .await;
        self.play("settings", json!({}), Some("11-settings.png"), |data| {
            format!(
                "pushHidden={} mailtoHidden={} notificationsOn={}",
                data["pushHidden"], data["mailtoHidden"], data["notificationsOn"]
            )
        })
        .await;
        self.play("features", json!({}), Some("12-features.png"), shown)
            .await;
        self.play("sections", json!({}), Some("13-sections.png"), shown)
            .await;
    }

    /// Piège HTML (C10) : aucun script, et l'IPC du cadre ne répond pas ; une notification venue du cadre est un échec.
    async fn trap(&mut self) {
        let started = Instant::now();
        let before = self.app.state::<Notified>().0.load(Ordering::SeqCst);
        let done = self.ask("trap", json!({}), STEP_TIMEOUT).await;
        let notified = self
            .app
            .state::<Notified>()
            .0
            .load(Ordering::SeqCst)
            .saturating_sub(before);
        let data = &done.data;
        let mut ok = done.ok && notified == 0 && data["frameIpc"].as_str() != Some("answered");
        let mut detail = format!(
            "sandbox={} trapRan={} ipcInFrame={} frameIpc={} notified+{notified}",
            data["sandbox"], data["trapRan"], data["ipcInFrame"], data["frameIpc"]
        );
        if !done.ok {
            detail = format!("{} {detail}", done.detail);
        }
        match self.capture("09-trap.png").await {
            Ok(shot) => detail = format!("{detail} {shot}"),
            Err(error) => {
                ok = false;
                detail = format!("{detail} capture 09-trap.png: {error}");
            }
        }
        self.line("trap", ok, started, &detail);
    }

    async fn resume(&mut self, credentials: &Credentials) {
        let email = credentials.user.clone();
        self.play(
            "resume",
            json!({ "email": email }),
            Some("20-resumed.png"),
            |data| {
                format!(
                    "unlocked={} themeKept={}",
                    data["unlocked"], data["themeKept"]
                )
            },
        )
        .await;
        self.play(
            "cleanup",
            json!({ "email": email }),
            Some("21-cleanup.png"),
            |_| String::new(),
        )
        .await;
        let started = Instant::now();
        let removed = keyring::Entry::new(VAULT_SERVICE, SELFTEST_DEVICE_KEY)
            .and_then(|entry| match entry.delete_credential() {
                Err(keyring::Error::NoEntry) => Ok(()),
                other => other,
            })
            .is_ok();
        self.line(
            "vault",
            removed,
            started,
            &format!("{SELFTEST_DEVICE_KEY} removed {removed}"),
        );
    }

    /// Télécharge la pièce jointe par le cœur dans `<dossier>/downloads` et la compare octet à octet à celle envoyée.
    async fn download(&mut self, attachment: &Value, sent: &[u8]) {
        let started = Instant::now();
        let url = attachment["url"].as_str().unwrap_or("");
        let target = if url.starts_with("/imap/") {
            NetTarget::Gateway {
                path: url.to_string(),
            }
        } else if url.starts_with("http://") || url.starts_with("https://") {
            NetTarget::Http {
                url: url.to_string(),
            }
        } else {
            self.line("download", false, started, "no attachment");
            return;
        };
        let headers: Vec<(String, String)> = attachment["headers"]
            .as_object()
            .map(|map| {
                map.iter()
                    .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let folder = self.folder.join("downloads");
        let _ = std::fs::create_dir_all(&folder);
        let path = folder.join(ATTACHMENT_NAME);
        let core = self.app.state::<Core>();
        let result = files::download_to(&core, target, headers, &path).await;
        match result {
            Ok(size) => {
                let same = std::fs::read(&path).is_ok_and(|bytes| bytes == sent);
                self.line(
                    "download",
                    same,
                    started,
                    &format!("{size} bytes identical {same}"),
                );
            }
            Err(error) => self.line("download", false, started, &error),
        }
    }

    /// Contrôle CA10 : le processus n'écoute sur aucun port, et ses connexions sortantes sont bien là.
    fn listen(&mut self) {
        let started = Instant::now();
        let (ok, detail) = listening();
        self.line("listen", ok, started, &detail);
    }

    /// Aucun secret dans le profil, les données du cœur ni le journal.
    fn secrets(&mut self, credentials: &Credentials) {
        let started = Instant::now();
        let basic = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", credentials.user, credentials.password))
        );
        let needles: Vec<Vec<u8>> = [credentials.password.as_str(), basic.as_str()]
            .iter()
            .flat_map(|text| [text.as_bytes().to_vec(), utf16le(text)])
            .collect();
        let mut found = 0;
        let mut unreadable = 0;
        #[allow(unused_mut)]
        let mut roots = vec![self.folder.join("profile"), self.folder.join("core")];
        // Données de WebKitGTK sous Linux.
        #[cfg(target_os = "linux")]
        {
            let path = self.app.path();
            roots.extend(
                [
                    path.app_data_dir(),
                    path.app_local_data_dir(),
                    path.app_cache_dir(),
                ]
                .into_iter()
                .flatten(),
            );
        }
        for root in roots {
            for file in walk(&root) {
                match std::fs::read(&file) {
                    Ok(bytes) => {
                        if needles.iter().any(|needle| contains(&bytes, needle)) {
                            found += 1;
                        }
                    }
                    Err(_) => unreadable += 1,
                }
            }
        }
        let detail = if found == 0 {
            format!("secrets on disk: none ({unreadable} unreadable)")
        } else {
            format!("secrets on disk: {found} files")
        };
        self.line("disk", found == 0, started, &detail);

        let started = Instant::now();
        let logs = voxel_core::log::recent().join("\n");
        let clean = !logs.contains(credentials.password.as_str())
            && !logs.contains(basic.as_str())
            && !logs.to_lowercase().contains("authorization");
        let detail = if clean { "logs clean" } else { "logs dirty" };
        self.line("logs", clean, started, detail);
    }

    fn finish(mut self) {
        let verdict = if self.failed {
            "SELFTEST FAIL"
        } else {
            "SELFTEST PASS"
        };
        self.lines.push(verdict.to_string());
        let text = format!("{}\n", self.lines.join("\n"));
        let _ = std::fs::create_dir_all(&self.folder);
        let _ = std::fs::write(self.folder.join("report.txt"), &text);
        // Le terminal qui a lancé l'auto-test peut être fermé : une sortie close ne garde pas l'appli ouverte.
        let _ = write!(std::io::stdout(), "{text}");
        self.app.exit(if self.failed { 1 } else { 0 });
    }
}

/// Résumé des étapes `features` et `sections`.
fn shown(data: &Value) -> String {
    format!(
        "announced={} expected={} shown={} errorToasts={}",
        data["announced"], data["expected"], data["shown"], data["errorToasts"]
    )
}

#[cfg(windows)]
fn listening() -> (bool, String) {
    let pid = std::process::id();
    let output = match std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).into_owned(),
        Err(error) => return (false, format!("netstat: {error}")),
    };
    let pid_text = pid.to_string();
    let ours: Vec<&str> = output
        .lines()
        .filter(|line| line.split_whitespace().last() == Some(pid_text.as_str()))
        .collect();
    let listening: Vec<&str> = ours
        .iter()
        .copied()
        .filter(|line| line.contains("LISTENING"))
        .collect();
    let udp: Vec<&str> = ours
        .iter()
        .copied()
        .filter(|line| line.trim_start().starts_with("UDP"))
        .collect();
    let established = ours
        .iter()
        .filter(|line| line.contains("ESTABLISHED"))
        .count();
    if listening.is_empty() && udp.is_empty() && established >= 1 {
        return (true, format!("none (pid {pid}, established {established})"));
    }
    let local: Vec<&str> = listening
        .iter()
        .chain(udp.iter())
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    (
        false,
        format!("{} (pid {pid}, established {established})", local.join(" ")),
    )
}

/// Hors Windows : `ss -H -ltnup` ; toute ligne du processus (`pid=<pid>,`) est une écoute.
#[cfg(not(windows))]
fn listening() -> (bool, String) {
    let pid = std::process::id();
    let output = match std::process::Command::new("ss")
        .args(["-H", "-ltnup"])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).into_owned(),
        Err(_) => return (true, "skipped (no ss)".to_string()),
    };
    let marker = format!("pid={pid},");
    let local: Vec<&str> = output
        .lines()
        .filter(|line| line.contains(&marker))
        .filter_map(|line| line.split_whitespace().nth(4))
        .collect();
    if local.is_empty() {
        (true, format!("none (pid {pid})"))
    } else {
        (false, format!("{} (pid {pid})", local.join(" ")))
    }
}

/// Identifiants du serveur choisi (`VOXEL_SELFTEST_*`), sinon ceux de la boîte de test. Jamais affichés ni écrits.
fn credentials() -> Option<Credentials> {
    let chosen = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    if let (Some(user), Some(password)) = (
        chosen("VOXEL_SELFTEST_USER"),
        chosen("VOXEL_SELFTEST_PASSWORD"),
    ) {
        return Some(Credentials {
            user,
            password,
            session_url: chosen("VOXEL_SELFTEST_SESSION_URL"),
            expected_url: None,
        });
    }
    let file = env_file();
    let test = |name: &str| chosen(name).or_else(|| file.get(name).cloned());
    Some(Credentials {
        user: test("VOXEL_TEST_USER")?,
        password: test("VOXEL_TEST_PASSWORD")?,
        session_url: None,
        expected_url: test("VOXEL_TEST_JMAP_URL"),
    })
}

/// Lignes `NOM=valeur` du premier `.env.test.local` trouvé en remontant depuis le dossier courant.
fn env_file() -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(mut folder) = std::env::current_dir() else {
        return values;
    };
    loop {
        if let Ok(text) = std::fs::read_to_string(folder.join(ENV_FILE)) {
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with('#') {
                    continue;
                }
                if let Some((name, value)) = line.split_once('=') {
                    values.insert(name.trim().to_string(), value.trim().to_string());
                }
            }
            return values;
        }
        if !folder.pop() {
            return values;
        }
    }
}

fn random_base36(len: usize) -> String {
    const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = vec![0u8; len];
    let _ = getrandom::fill(&mut bytes);
    bytes
        .iter()
        .map(|byte| ALPHABET[*byte as usize % 36] as char)
        .collect()
}

fn utf16le(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files
}
