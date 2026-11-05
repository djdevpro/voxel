//! Flux d'événements JMAP (RFC 8620 §7.3) de `/imap/events` : les StateChange de la façade mis en forme SSE,
//! avec les pings émis par la passerelle. Le lecteur qui lâche le flux arrête la tâche et désabonne la façade.

use std::time::Duration;

use bytes::Bytes;
use tokio::sync::mpsc;
use voxel_core::http::{BodyStream, receiver_stream};

/// Capacité du canal de sortie vers le lecteur.
const OUT_CAPACITY: usize = 16;

/// Flux SSE d'un abonnement ; `ping` en secondes, 0 pour aucun.
pub fn event_stream(
    mut events: mpsc::Receiver<serde_json::Value>,
    ping: u64,
    close_after_state: bool,
) -> BodyStream {
    let (tx, rx) = mpsc::channel::<Bytes>(OUT_CAPACITY);
    tokio::spawn(async move {
        if tx.send(Bytes::from_static(b": ok\n\n")).await.is_err() {
            return;
        }
        let period = Duration::from_secs(ping.max(1));
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            tokio::select! {
                event = events.recv() => {
                    let Some(event) = event else { break };
                    let chunk = format!("event: state\ndata: {event}\n\n");
                    if tx.send(Bytes::from(chunk)).await.is_err() || close_after_state {
                        break;
                    }
                }
                _ = ticks.tick(), if ping > 0 => {
                    let chunk = format!("event: ping\ndata: {{\"interval\":{ping}}}\n\n");
                    if tx.send(Bytes::from(chunk)).await.is_err() {
                        break;
                    }
                }
                _ = tx.closed() => break,
            }
        }
    });
    receiver_stream(rx)
}
