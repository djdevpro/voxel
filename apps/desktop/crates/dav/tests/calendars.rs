//! Client CalDAV (même client WebDAV que les contacts) et façade CalDAV → JMAP Calendars contre un faux serveur
//! CalDAV en mémoire (avec et sans `sync-collection`), branché comme `DavTransport`. Port de
//! `apps/server/test/caldav.test.ts`. Le contenu des événements suit les règles C de l'adaptateur.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, UploadSource};
use voxel_core::jmap::{CreatedIds, Object};
use voxel_core::net::HttpRequest;
use voxel_dav::CalDavFacade;
use voxel_dav::client::{DavClient, DavError, DavHttpResponse, DavKind, DavTransport};

// ------------------------------------------------------------------ faux serveur CalDAV

const ORIGIN: &str = "https://cal.example.com";
const DEFAULT: &str = "/dav/cal/u/default/";
const WORK: &str = "/dav/cal/u/work/";

struct Item {
    etag: String,
    data: String,
}

struct Cal {
    href: String,
    name: String,
    color: String,
    items: Vec<(String, Item)>,
}

struct State {
    cals: Vec<Cal>,
    log: Vec<(u32, String, String, bool)>,
    version: u32,
    etag_n: u32,
    calls: Vec<String>,
}

impl State {
    fn cal(&mut self, href: &str) -> &mut Cal {
        self.cals.iter_mut().find(|c| c.href == href).unwrap()
    }

    fn bump(&mut self, cal: &str, href: String, deleted: bool) {
        self.version += 1;
        let v = self.version;
        self.log.push((v, href, cal.to_string(), deleted));
    }

    fn set_item(&mut self, cal: &str, name: &str, data: &str) -> String {
        self.etag_n += 1;
        let etag = format!("\"{}\"", self.etag_n);
        let item = Item {
            etag: etag.clone(),
            data: data.to_string(),
        };
        let c = self.cal(cal);
        match c.items.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = item,
            None => c.items.push((name.to_string(), item)),
        }
        etag
    }
}

struct FakeCalDav {
    sync: bool,
    auth: String,
    state: Mutex<State>,
    /// Modification « par un autre client » juste avant le prochain PUT.
    race: Mutex<Option<(String, String, String)>>,
}

fn percent_decode(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(Ok(v)) = text.get(i + 1..i + 3).map(|h| u8::from_str_radix(h, 16))
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

fn ms(inner: &str, token: Option<&str>) -> String {
    format!(
        "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\" xmlns:A=\"http://apple.com/ns/ical/\">{inner}{}</D:multistatus>",
        token
            .map(|t| format!("<D:sync-token>{t}</D:sync-token>"))
            .unwrap_or_default()
    )
}

fn ok(href: &str, props: &str) -> String {
    format!(
        "<D:response><D:href>{href}</D:href><D:propstat><D:prop>{props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
    )
}

fn gone(href: &str) -> String {
    format!(
        "<D:response><D:href>{href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>"
    )
}

fn reply(status: u16, body: String, headers: Vec<(&str, String)>) -> DavHttpResponse {
    DavHttpResponse {
        status,
        headers: headers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        body: bytes::Bytes::from(body),
    }
}

impl FakeCalDav {
    fn new(sync: bool) -> Arc<Self> {
        let cal = |href: &str, name: &str, color: &str| Cal {
            href: href.into(),
            name: name.into(),
            color: color.into(),
            items: Vec::new(),
        };
        Arc::new(Self {
            sync,
            auth: format!("Basic {}", STANDARD.encode("u:p")),
            state: Mutex::new(State {
                cals: vec![
                    cal(DEFAULT, "Agenda", "#FF0000FF"),
                    cal(WORK, "Travail", ""),
                ],
                log: Vec::new(),
                version: 1,
                etag_n: 100,
                calls: Vec::new(),
            }),
            race: Mutex::new(None),
        })
    }

    fn touch(&self, cal: &str, name: &str, data: &str) {
        let mut st = self.state.lock().unwrap();
        st.set_item(cal, name, data);
        st.bump(cal, format!("{cal}{name}"), false);
    }

    fn datas(&self, cal: &str) -> Vec<String> {
        let mut st = self.state.lock().unwrap();
        st.cal(cal)
            .items
            .iter()
            .map(|(_, i)| i.data.clone())
            .collect()
    }

    fn handle(
        &self,
        method: &str,
        url: &url::Url,
        headers: &[(String, String)],
        body: &str,
    ) -> DavHttpResponse {
        let header = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        let query = if body.contains("calendar-query") {
            " query"
        } else {
            ""
        };
        self.state
            .lock()
            .unwrap()
            .calls
            .push(format!("{method} {}{query}", url.path()));
        if header("authorization").as_deref() != Some(self.auth.as_str()) {
            return reply(
                401,
                String::new(),
                vec![("WWW-Authenticate", "Basic".into())],
            );
        }
        if method == "PUT"
            && let Some((cal, name, data)) = self.race.lock().unwrap().take()
        {
            self.touch(&cal, &name, &data);
        }
        let path = percent_decode(url.path());
        let mut st = self.state.lock().unwrap();
        if path == "/.well-known/caldav" {
            return reply(301, String::new(), vec![("Location", "/dav/cal/".into())]);
        }
        if method == "PROPFIND" && path == "/dav/cal/" {
            let props = "<D:current-user-principal><D:href>/dav/principals/u/</D:href></D:current-user-principal>";
            return reply(207, ms(&ok("/dav/cal/", props), None), vec![]);
        }
        if method == "PROPFIND" && path == "/dav/principals/u/" {
            let props = "<C:calendar-home-set><D:href>/dav/cal/u/</D:href></C:calendar-home-set>";
            return reply(207, ms(&ok("/dav/principals/u/", props), None), vec![]);
        }
        if method == "PROPFIND" && path == "/dav/cal/u/" {
            let mut inner = ok(
                "/dav/cal/u/",
                "<D:resourcetype><D:collection/></D:resourcetype>",
            );
            for c in &st.cals {
                let color = if c.color.is_empty() {
                    String::new()
                } else {
                    format!("<A:calendar-color>{}</A:calendar-color>", c.color)
                };
                let sync = if self.sync {
                    format!(
                        "<D:sync-token>tok-{}</D:sync-token><D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>",
                        st.version
                    )
                } else {
                    String::new()
                };
                inner += &ok(
                    &c.href,
                    &format!(
                        "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>{}</D:displayname>{color}{sync}<D:current-user-privilege-set><D:privilege><D:all/></D:privilege></D:current-user-privilege-set>",
                        c.name
                    ),
                );
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        let Some(cal_href) = st
            .cals
            .iter()
            .map(|c| c.href.clone())
            .find(|h| path.starts_with(h.as_str()))
        else {
            return reply(404, String::new(), vec![]);
        };
        let listing = |st: &mut State| {
            let mut inner = String::new();
            for (name, it) in &st.cal(&cal_href).items {
                inner += &ok(
                    &format!("{cal_href}{}", encode(name)),
                    &format!("<D:getetag>{}</D:getetag>", xml(&it.etag)),
                );
            }
            inner
        };
        if method == "PROPFIND" && path == cal_href {
            let mut inner = ok(
                &cal_href,
                "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>",
            );
            for (name, it) in &st.cal(&cal_href).items {
                inner += &ok(
                    &format!("{cal_href}{}", encode(name)),
                    &format!("<D:getetag>{}</D:getetag><D:resourcetype/>", xml(&it.etag)),
                );
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        if method == "REPORT" && body.contains("sync-collection") {
            if !self.sync {
                return reply(403, String::new(), vec![]);
            }
            let tok = body
                .split("<d:sync-token>")
                .nth(1)
                .and_then(|r| r.split('<').next())
                .unwrap_or("");
            let since: u32 = tok.trim_start_matches("tok-").parse().unwrap_or(0);
            let mut inner = String::new();
            let mut seen: Vec<String> = Vec::new();
            let log: Vec<(u32, String, String, bool)> = st.log.iter().rev().cloned().collect();
            for (v, href, cal, deleted) in log {
                if v <= since || cal != cal_href || seen.contains(&href) {
                    continue;
                }
                seen.push(href.clone());
                let name = href[cal_href.len()..].to_string();
                let item = st
                    .cal(&cal_href)
                    .items
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, i)| i.etag.clone());
                let target = format!("{cal_href}{}", encode(&name));
                inner += &match item {
                    Some(etag) if !deleted => {
                        ok(&target, &format!("<D:getetag>{}</D:getetag>", xml(&etag)))
                    }
                    _ => gone(&target),
                };
            }
            let token = format!("tok-{}", st.version);
            return reply(207, ms(&inner, Some(&token)), vec![]);
        }
        if method == "REPORT" && body.contains("calendar-query") {
            // le faux serveur ne filtre pas la plage : la façade refait le tri en mémoire
            let inner = listing(&mut st);
            return reply(207, ms(&inner, None), vec![]);
        }
        if method == "REPORT" && body.contains("calendar-multiget") {
            let mut inner = String::new();
            for part in body.split("<d:href>").skip(1) {
                let href = part.split("</d:href>").next().unwrap_or("");
                let name = percent_decode(href)[cal_href.len()..].to_string();
                inner += &match st.cal(&cal_href).items.iter().find(|(n, _)| *n == name) {
                    Some((_, it)) => ok(
                        href,
                        &format!(
                            "<D:getetag>{}</D:getetag><C:calendar-data><![CDATA[{}]]></C:calendar-data>",
                            xml(&it.etag),
                            it.data
                        ),
                    ),
                    None => gone(href),
                };
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        let name = path[cal_href.len()..].to_string();
        let cur = st
            .cal(&cal_href)
            .items
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, i)| i.etag.clone());
        match method {
            "PUT" => {
                assert!(
                    header("content-type")
                        .unwrap_or_default()
                        .starts_with("text/calendar")
                );
                if header("if-none-match").as_deref() == Some("*") && cur.is_some() {
                    return reply(412, String::new(), vec![]);
                }
                if let Some(im) = header("if-match")
                    && cur.as_deref() != Some(im.as_str())
                {
                    return reply(412, String::new(), vec![]);
                }
                let etag = st.set_item(&cal_href, &name, body);
                st.bump(&cal_href, format!("{cal_href}{name}"), false);
                reply(
                    if cur.is_some() { 204 } else { 201 },
                    String::new(),
                    vec![("ETag", etag)],
                )
            }
            "DELETE" => {
                let Some(cur) = cur else {
                    return reply(404, String::new(), vec![]);
                };
                if let Some(im) = header("if-match")
                    && cur != im
                {
                    return reply(412, String::new(), vec![]);
                }
                st.cal(&cal_href).items.retain(|(n, _)| *n != name);
                st.bump(&cal_href, format!("{cal_href}{name}"), true);
                reply(204, String::new(), vec![])
            }
            _ => reply(405, String::new(), vec![]),
        }
    }
}

impl DavTransport for FakeCalDav {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        _timeout: Duration,
    ) -> BoxFuture<'a, Result<DavHttpResponse, DavError>> {
        Box::pin(async move {
            let mut url = url::Url::parse(&request.url).unwrap();
            let body = String::from_utf8_lossy(&request.body).into_owned();
            for _ in 0..5 {
                let res = self.handle(request.method.as_str(), &url, &request.headers, &body);
                let location = res
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("location"))
                    .map(|(_, v)| v.clone());
                match location {
                    Some(loc) if (300..400).contains(&res.status) => url = url.join(&loc).unwrap(),
                    _ => return Ok(res),
                }
            }
            Err(DavError::Network("too many redirects".into()))
        })
    }
}

fn ics(uid: &str, title: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;TZID=Europe/Paris:20261110T090000\r\nDTEND;TZID=Europe/Paris:20261110T100000\r\nSUMMARY:{title}\r\nX-CUSTOM:garde-moi\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
}

#[derive(Default)]
struct Uploads(BTreeMap<String, Vec<u8>>);

impl UploadSource for Uploads {
    fn load<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<bytes::Bytes>> {
        Box::pin(async move { self.0.get(blob_id).cloned().map(bytes::Bytes::from) })
    }
}

fn facade(fake: &Arc<FakeCalDav>) -> Arc<CalDavFacade> {
    CalDavFacade::new(
        url::Url::parse(&format!("{ORIGIN}/.well-known/caldav")).unwrap(),
        "u".into(),
        "p".into(),
        fake.clone(),
    )
}

async fn call(
    f: &CalDavFacade,
    method: &str,
    args: Value,
    created: &mut CreatedIds,
    uploads: &Uploads,
) -> Value {
    let args: Object = args.as_object().cloned().unwrap_or_default();
    Value::Object(
        f.call(method, args, CallContext { created, uploads })
            .await
            .unwrap_or_else(|e| panic!("{method}: {e:?}")),
    )
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn client_discovery_color_and_rejected_credentials() {
    let fake = FakeCalDav::new(true);
    let service = url::Url::parse(&format!("{ORIGIN}/dav/cal/")).unwrap();
    let list = DavClient::new(service.clone(), "u", "p", fake.clone())
        .discover(DavKind::Cal, Duration::from_secs(15))
        .await
        .unwrap();
    let rows: Vec<(String, Option<String>, bool, bool)> = list
        .iter()
        .map(|c| {
            (
                c.name.clone(),
                c.color.clone(),
                c.supports_sync,
                c.may_write,
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "Agenda".to_string(),
                Some("#ff0000".to_string()),
                true,
                true
            ),
            ("Travail".to_string(), None, true, true)
        ]
    );
    let err = DavClient::new(service, "u", "mauvais", fake.clone())
        .discover(DavKind::Cal, Duration::from_secs(15))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("authentication"));
}

async fn full_scenario(sync: bool) {
    let fake = FakeCalDav::new(sync);
    let f = facade(&fake);
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    f.probe().await;
    assert!(f.available());
    assert!(
        f.capabilities()
            .unwrap()
            .core
            .contains_key("urn:ietf:params:jmap:calendars")
    );
    let cals = call(&f, "Calendar/get", json!({"ids": null}), &mut ids, &uploads).await;
    let rows: Vec<(Value, Value, Value)> = cals["list"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].clone(),
                c["color"].clone(),
                c["isDefault"].clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (json!("Agenda"), json!("#ff0000"), json!(true)),
            (json!("Travail"), Value::Null, json!(false))
        ]
    );
    let def = cals["list"][0]["id"].as_str().unwrap().to_string();
    let work = cals["list"][1]["id"].as_str().unwrap().to_string();

    let s0 = call(
        &f,
        "CalendarEvent/get",
        json!({"ids": []}),
        &mut ids,
        &uploads,
    )
    .await["state"]
        .clone();
    let r = call(
        &f,
        "CalendarEvent/set",
        json!({"create": {
            "a": {
                "calendarIds": {def.clone(): true},
                "uid": "serie-1",
                "title": "Réunion",
                "start": "2026-11-10T09:00:00",
                "timeZone": "Europe/Paris",
                "duration": "PT1H",
                "recurrenceRules": [{"frequency": "weekly", "byDay": [{"day": "tu"}, {"day": "th"}], "count": 6}],
                "recurrenceOverrides": {"2026-11-17T09:00:00": {"excluded": true}},
                "alerts": {"a": {"@type": "Alert", "trigger": {"@type": "OffsetTrigger", "offset": "-PT10M"}}}
            },
            "b": {"calendarIds": {work.clone(): true}, "title": "Journée", "start": "2026-12-01T00:00:00", "showWithoutTime": true, "duration": "P1D"},
            "bad": {"title": "sans début"}
        }}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(r["notCreated"]["bad"].is_object());
    let id_a = ids.resolve("#a");
    let id_b = ids.resolve("#b");
    let stored = fake.datas(DEFAULT).join("");
    assert!(
        stored.contains("RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=TU,TH")
            || stored.contains("RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6"),
        "{stored}"
    );

    // un autre client ajoute un événement avec une propriété inconnue
    fake.touch(DEFAULT, "externe.ics", &ics("ext-1", "Externe"));
    f.close(); // instantané DAV gardé 3 s : on force la relecture
    let all = call(
        &f,
        "CalendarEvent/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let evs = all["list"].as_array().unwrap();
    assert_eq!(evs.len(), 3);
    let ext = evs.iter().find(|e| e["uid"] == "ext-1").unwrap().clone();
    assert_eq!(
        ext["iCalendar"]["properties"],
        json!([["x-custom", {}, "unknown", "garde-moi"]])
    );
    assert_eq!(ext["timeZone"], "Europe/Paris");
    let ext_id = ext["id"].as_str().unwrap().to_string();

    // plage et filtres
    let q = call(
        &f,
        "CalendarEvent/query",
        json!({"filter": {"after": "2026-11-11T00:00:00Z", "before": "2026-11-20T00:00:00Z"}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(strs(&q["ids"]), vec![id_a.clone()]);
    let qc = call(
        &f,
        "CalendarEvent/query",
        json!({"filter": {"inCalendar": work.clone()}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(strs(&qc["ids"]), vec![id_b.clone()]);
    let qt = call(
        &f,
        "CalendarEvent/query",
        json!({"filter": {"text": "reunion"}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(strs(&qt["ids"]), vec![id_a.clone()]);
    // développement : occurrences dans la plage (17 exclu), ids lisibles par get
    let qe = call(
        &f,
        "CalendarEvent/query",
        json!({"filter": {"inCalendar": def.clone(), "after": "2026-11-09T00:00:00Z", "before": "2026-11-20T00:00:00Z"}, "expandRecurrences": true}),
        &mut ids,
        &uploads,
    )
    .await;
    let occ_ids = strs(&qe["ids"]);
    assert_eq!(occ_ids.len(), 4, "{occ_ids:?}"); // 10 (série), 10 externe, 12, 19
    let only_occ: Vec<String> = occ_ids
        .iter()
        .filter(|i| i.contains('_'))
        .cloned()
        .collect();
    let occ = call(
        &f,
        "CalendarEvent/get",
        json!({"ids": only_occ}),
        &mut ids,
        &uploads,
    )
    .await;
    let pairs: Vec<(Value, Value)> = occ["list"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["recurrenceId"].clone(), o["baseEventId"].clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            (json!("2026-11-10T09:00:00"), json!(id_a)),
            (json!("2026-11-12T09:00:00"), json!(id_a)),
            (json!("2026-11-19T09:00:00"), json!(id_a))
        ]
    );

    // « cet événement » par l'id d'occurrence, puis suppression d'une occurrence
    let occ12 = occ_ids
        .iter()
        .find(|i| i.ends_with("_20261112T090000"))
        .unwrap()
        .clone();
    let occ19 = occ_ids
        .iter()
        .find(|i| i.ends_with("_20261119T090000"))
        .unwrap()
        .clone();
    let u1 = call(
        &f,
        "CalendarEvent/set",
        json!({"update": {occ12.clone(): {"title": "Déplacée", "start": "2026-11-12T11:00:00"}}, "destroy": [occ19.clone()], "sendSchedulingMessages": true}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(u1["notUpdated"], Value::Null);
    assert_eq!(u1["destroyed"], json!([occ19]));
    let a2 = call(
        &f,
        "CalendarEvent/get",
        json!({"ids": [id_a.clone()]}),
        &mut ids,
        &uploads,
    )
    .await["list"][0]
        .clone();
    let overrides = &a2["recurrenceOverrides"];
    assert_eq!(overrides["2026-11-17T09:00:00"], json!({"excluded": true}));
    assert_eq!(overrides["2026-11-19T09:00:00"], json!({"excluded": true}));
    assert_eq!(overrides["2026-11-12T09:00:00"]["title"], "Déplacée");
    assert_eq!(
        overrides["2026-11-12T09:00:00"]["start"],
        "2026-11-12T11:00:00"
    );
    assert_eq!(overrides.as_object().unwrap().len(), 3);
    assert_eq!(a2["sequence"], 2);
    // l'exception du 12 n'a pas la SEQUENCE de la série : une seule occurrence par recurrenceId
    let qe2 = call(
        &f,
        "CalendarEvent/query",
        json!({"filter": {"inCalendar": def.clone(), "after": "2026-11-09T00:00:00Z", "before": "2026-11-20T00:00:00Z"}, "expandRecurrences": true}),
        &mut ids,
        &uploads,
    )
    .await;
    let after_edit = strs(&qe2["ids"]);
    assert_eq!(
        after_edit
            .iter()
            .filter(|i| i.ends_with("_20261112T090000"))
            .count(),
        1,
        "{after_edit:?}"
    );
    assert_eq!(after_edit.len(), 3, "{after_edit:?}"); // 10 (série), 10 externe, 12 ; 19 exclu
    let data = fake.datas(DEFAULT).join("");
    assert!(
        data.contains("RECURRENCE-ID;TZID=Europe/Paris:20261112T090000"),
        "{data}"
    );

    // toute la série : patch ; changement d'agenda (nouvel id)
    let u2 = call(
        &f,
        "CalendarEvent/set",
        json!({"update": {id_a.clone(): {"title": "Réunion 2", format!("calendarIds/{def}"): null, format!("calendarIds/{work}"): true}}}),
        &mut ids,
        &uploads,
    )
    .await;
    let moved = u2["updated"][&id_a]["id"].as_str().unwrap().to_string();
    assert_ne!(moved, id_a);
    assert_eq!(fake.datas(WORK).len(), 2);

    // changes depuis l'état initial
    let ch = call(
        &f,
        "CalendarEvent/changes",
        json!({"sinceState": s0}),
        &mut ids,
        &uploads,
    )
    .await;
    let touched = [strs(&ch["created"]), strs(&ch["updated"])].concat();
    for id in [&moved, &id_b, &ext_id] {
        assert!(touched.contains(id), "{id}");
    }
    // créé puis déplacé depuis s0 : sync-collection le signale supprimé ; par ETag, il n'a jamais existé pour s0
    if sync {
        assert!(strs(&ch["destroyed"]).contains(&id_a));
    } else {
        assert!(!touched.contains(&id_a));
    }

    // suppression
    let d = call(
        &f,
        "CalendarEvent/set",
        json!({"destroy": [moved.clone(), id_b.clone(), ext_id.clone()]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(d["destroyed"], json!([moved, id_b, ext_id]));
    assert_eq!(fake.datas(DEFAULT).len() + fake.datas(WORK).len(), 0);
    let ch2 = call(
        &f,
        "CalendarEvent/changes",
        json!({"sinceState": ch["newState"]}),
        &mut ids,
        &uploads,
    )
    .await;
    let mut gone = strs(&ch2["destroyed"]);
    gone.sort();
    let mut expected = vec![moved, id_b, ext_id];
    expected.sort();
    assert_eq!(gone, expected);
}

#[tokio::test]
async fn facade_with_sync_collection() {
    full_scenario(true).await;
}

#[tokio::test]
async fn facade_with_etags() {
    full_scenario(false).await;
}

#[tokio::test]
async fn facade_etag_conflict_is_state_mismatch() {
    let fake = FakeCalDav::new(false);
    let f = facade(&fake);
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    f.probe().await;
    fake.touch(DEFAULT, "x.ics", &ics("x", "X"));
    let id = call(
        &f,
        "CalendarEvent/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await["list"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // écriture concurrente entre la lecture de l'état DAV et le PUT
    let f2 = facade(&fake);
    f2.probe().await;
    *fake.race.lock().unwrap() = Some((DEFAULT.into(), "x.ics".into(), ics("x", "X concurrent")));
    let r = call(
        &f2,
        "CalendarEvent/set",
        json!({"update": {id.clone(): {"title": "Y"}}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(r["notUpdated"][&id]["type"], "stateMismatch");
}

#[tokio::test]
async fn facade_parse_all_vevents_without_state() {
    let fake = FakeCalDav::new(true);
    let two = format!(
        "{}BEGIN:VEVENT\r\nUID:p2\r\nDTSTART;VALUE=DATE:20261121\r\nSUMMARY:Deux\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        ics("p1", "Un").replace("END:VCALENDAR\r\n", "")
    );
    let uploads = Uploads(BTreeMap::from([
        ("b1".to_string(), two.into_bytes()),
        ("b2".to_string(), b"pas un ics".to_vec()),
    ]));
    let f = facade(&fake);
    let mut ids = CreatedIds::default();
    f.probe().await;
    let r = call(
        &f,
        "CalendarEvent/parse",
        json!({"blobIds": ["b1", "b2", "b3"]}),
        &mut ids,
        &uploads,
    )
    .await;
    let p: Vec<(Value, Value)> = r["parsed"]["b1"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["uid"].clone(), e["title"].clone()))
        .collect();
    assert_eq!(
        p,
        vec![(json!("p1"), json!("Un")), (json!("p2"), json!("Deux"))]
    );
    assert_eq!(r["notParsable"], json!(["b2"]));
    assert_eq!(r["notFound"], json!(["b3"]));
    // aucun appel d'écriture vers le serveur DAV
    let calls = fake.state.lock().unwrap().calls.clone();
    assert!(
        !calls
            .iter()
            .any(|c| c.starts_with("PUT") || c.starts_with("DELETE"))
    );
}
