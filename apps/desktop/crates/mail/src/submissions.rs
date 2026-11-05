//! Envoi SMTP (port de `submission.ts`) : EmailSubmission/set|get et vérification SMTP. Le MIME vient du
//! message déjà enregistré (brouillon) ; le Bcc est retiré avant l'envoi. Les envois sont gardés en mémoire
//! (200 au plus) pour EmailSubmission/get.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use voxel_core::backend::MailAccount;
use voxel_core::error::BackendError;
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object, SetError};
use voxel_core::util::{Lru, hash_of, now_ms, random_base36, utc_date};
use voxel_imap::ImapError;
use voxel_imap::compose::strip_bcc;
use voxel_imap::smtp::{SendError, SmtpAccount, smtp_send, smtp_verify};

use crate::identities::Identities;
use crate::jmap_json::{as_object, js_string, object_or_null};
use crate::messages::Messages;

/// Envois gardés pour EmailSubmission/get.
const KEPT: usize = 200;

pub struct Submissions {
    account: SmtpAccount,
    email: String,
    sent: Mutex<Lru<String, Value>>,
    state_counter: AtomicU64,
}

pub struct SubmissionOutcome {
    pub response: Object,
    pub email_set: Option<Object>,
}

/// Erreur SMTP qui interrompt la méthode.
fn fatal(e: ImapError) -> BackendError {
    match e {
        ImapError::Auth(m) => BackendError::Auth(m),
        other => BackendError::Unavailable(other.to_string()),
    }
}

impl Submissions {
    pub fn new(account: &MailAccount) -> Self {
        Submissions {
            account: SmtpAccount {
                host: account.smtp.host.clone(),
                port: account.smtp.port,
                secure: account.smtp.secure,
                username: account.username.clone(),
                password: account.password.clone(),
            },
            email: account.email.clone(),
            sent: Mutex::new(Lru::new(KEPT)),
            state_counter: AtomicU64::new(0),
        }
    }

    pub async fn verify(&self) -> Result<(), BackendError> {
        smtp_verify(&self.account).await.map_err(fatal)
    }

    fn state(&self) -> String {
        format!(
            "s{}",
            hash_of(
                &format!(
                    "{}|{}",
                    self.email,
                    self.state_counter.load(Ordering::SeqCst)
                ),
                10
            )
        )
    }

    pub fn get(&self, args: &Object) -> Object {
        let mut r = Object::new();
        r.insert("state".into(), json!(self.state()));
        match args.get("ids").and_then(Value::as_array) {
            Some(ids) => {
                let mut list = Vec::new();
                let mut not_found = Vec::new();
                let mut sent = self.sent.lock().unwrap_or_else(|e| e.into_inner());
                for id in ids {
                    match sent.get(&js_string(id)) {
                        Some(s) => list.push(s.clone()),
                        None => not_found.push(id.clone()),
                    }
                }
                r.insert("list".into(), Value::Array(list));
                r.insert("notFound".into(), Value::Array(not_found));
            }
            None => {
                r.insert("list".into(), json!([]));
                r.insert("notFound".into(), json!([]));
            }
        }
        r
    }

    /// EmailSubmission/set. Renvoie la réponse et, si des actions onSuccess* sont demandées, les arguments
    /// d'un Email/set implicite (RFC 8621 §7.5).
    pub async fn set(
        &self,
        args: &Object,
        ctx: &mut CreatedIds,
        messages: &Arc<Messages>,
        identities: &Identities,
    ) -> Result<SubmissionOutcome, FacadeError> {
        let old_state = self.state();
        if let Some(s) = args.get("ifInState").and_then(Value::as_str)
            && s != old_state
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let mut created = Object::new();
        let mut not_created = Object::new();
        let mut sub_to_email: HashMap<String, String> = HashMap::new();

        if let Some(create) = as_object(args.get("create")) {
            for (cid, obj) in create {
                match self.send_one(obj, ctx, messages, identities).await {
                    Ok((id, email_id, send_at)) => {
                        sub_to_email.insert(format!("#{cid}"), email_id.clone());
                        sub_to_email.insert(id.clone(), email_id);
                        ctx.record(cid, &id);
                        created.insert(
                            cid.clone(),
                            json!({ "id": id, "sendAt": send_at, "undoStatus": "final" }),
                        );
                    }
                    Err(FacadeError::Backend(e)) => return Err(FacadeError::Backend(e)),
                    Err(e) => {
                        not_created.insert(cid.clone(), e.set_error_json());
                    }
                }
            }
        }

        let mut not_updated = Object::new();
        if let Some(update) = as_object(args.get("update")) {
            for id in update.keys() {
                not_updated.insert(
                    id.clone(),
                    json!({ "type": "cannotUnsend", "description": "messages are sent immediately" }),
                );
            }
        }
        let mut not_destroyed = Object::new();
        for id in args
            .get("destroy")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            not_destroyed.insert(js_string(id), json!({ "type": "forbidden" }));
        }

        // actions implicites sur les emails envoyés
        let email_of = |r: &str| {
            sub_to_email
                .get(r)
                .or_else(|| sub_to_email.get(&ctx.resolve(r)))
                .cloned()
        };
        let mut update = Object::new();
        let mut destroy: Vec<String> = Vec::new();
        if let Some(on_update) = as_object(args.get("onSuccessUpdateEmail")) {
            for (r, patch) in on_update {
                if let Some(email_id) = email_of(r)
                    && patch.is_object()
                {
                    update.insert(email_id, patch.clone());
                }
            }
        }
        if let Some(on_destroy) = args.get("onSuccessDestroyEmail").and_then(Value::as_array) {
            for r in on_destroy {
                if let Some(email_id) = email_of(&js_string(r)) {
                    destroy.push(email_id);
                }
            }
        }
        let email_set = (!update.is_empty() || !destroy.is_empty()).then(|| {
            let mut o = Object::new();
            o.insert("update".into(), Value::Object(update));
            o.insert("destroy".into(), json!(destroy));
            o
        });

        let mut response = Object::new();
        response.insert("oldState".into(), json!(old_state));
        response.insert("newState".into(), json!(self.state()));
        response.insert("created".into(), object_or_null(created));
        response.insert("updated".into(), Value::Null);
        response.insert("destroyed".into(), Value::Null);
        response.insert("notCreated".into(), object_or_null(not_created));
        response.insert("notUpdated".into(), object_or_null(not_updated));
        response.insert("notDestroyed".into(), object_or_null(not_destroyed));
        Ok(SubmissionOutcome {
            response,
            email_set,
        })
    }

    /// Un envoi : (id de l'envoi, id de l'email, date d'envoi).
    async fn send_one(
        &self,
        obj: &Value,
        ctx: &CreatedIds,
        messages: &Arc<Messages>,
        identities: &Identities,
    ) -> Result<(String, String, String), FacadeError> {
        let obj = obj
            .as_object()
            .ok_or_else(|| SetError::new("invalidProperties"))?;
        let email_id = obj
            .get("emailId")
            .and_then(Value::as_str)
            .map(|e| ctx.resolve(e))
            .unwrap_or_default();
        if email_id.is_empty() {
            return Err(SetError::on("invalidProperties", "emailId required", &["emailId"]).into());
        }
        let identity_id = obj
            .get("identityId")
            .and_then(Value::as_str)
            .map(|i| ctx.resolve(i))
            .unwrap_or_default();
        let identity = identities.find(&identity_id).ok_or_else(|| {
            SetError::on("invalidProperties", "identity not found", &["identityId"])
        })?;
        let info = messages
            .envelope_of(&email_id)
            .await?
            .ok_or_else(|| SetError::on("invalidProperties", "email not found", &["emailId"]))?;
        let env = as_object(obj.get("envelope"));
        let identity_email = identity
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mail_from = env
            .and_then(|e| e.get("mailFrom"))
            .and_then(|m| m.get("email"))
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or(identity_email);
        let rcpt_raw: Vec<String> =
            match env.and_then(|e| e.get("rcptTo")).and_then(Value::as_array) {
                Some(list) => list
                    .iter()
                    .filter_map(|r| r.get("email").and_then(Value::as_str))
                    .filter(|e| !e.is_empty())
                    .map(String::from)
                    .collect(),
                None => {
                    let identity_bcc: Vec<String> = identity
                        .get("bcc")
                        .and_then(Value::as_array)
                        .map(|l| {
                            l.iter()
                                .filter_map(|a| {
                                    a.get("email").and_then(Value::as_str).map(String::from)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    info.to
                        .iter()
                        .chain(&info.cc)
                        .chain(&info.bcc)
                        .map(|a| a.email.clone())
                        .chain(identity_bcc)
                        .collect()
                }
            };
        let mut rcpt: Vec<String> = Vec::new();
        for r in rcpt_raw.iter().map(|r| r.trim().to_string()) {
            if !r.is_empty() && !rcpt.contains(&r) {
                rcpt.push(r);
            }
        }
        if rcpt.is_empty() {
            return Err(SetError::described("noRecipients", "no recipients").into());
        }
        let Some((data, _)) = messages.load_blob(&email_id).await? else {
            return Err(
                SetError::on("invalidProperties", "email source not found", &["emailId"]).into(),
            );
        };
        let raw = strip_bcc(&data);
        match smtp_send(&self.account, &mail_from, &rcpt, &raw).await {
            Ok(()) => {}
            Err(SendError::Fatal(e)) => return Err(FacadeError::Backend(fatal(e))),
            Err(SendError::Rejected { permanent, message }) => {
                let kind = if permanent {
                    "forbiddenToSend"
                } else {
                    "serverFail"
                };
                return Err(SetError::described(kind, message).into());
            }
        }
        let id = format!("S{}", random_base36(10));
        let send_at = utc_date(now_ms());
        let sub = json!({
            "id": id,
            "identityId": identity_id,
            "emailId": email_id,
            "threadId": null,
            "envelope": {
                "mailFrom": { "email": mail_from, "parameters": null },
                "rcptTo": rcpt.iter().map(|email| json!({ "email": email, "parameters": null })).collect::<Vec<_>>(),
            },
            "sendAt": send_at,
            "undoStatus": "final",
            "deliveryStatus": null,
            "dsnBlobIds": [],
            "mdnBlobIds": [],
        });
        self.sent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), sub);
        self.state_counter.fetch_add(1, Ordering::SeqCst);
        Ok((id, email_id, send_at))
    }
}
