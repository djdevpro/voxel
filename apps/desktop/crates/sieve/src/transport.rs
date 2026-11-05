//! Transport ManageSieve de production : TCP puis TLS implicite, ou TCP en clair suivi de STARTTLS (jamais
//! d'authentification en clair). Port de `apps/server/src/sieve/transport.ts`, sans restriction de port ni
//! d'adresse (D6).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use voxel_core::backend::Endpoint;
use voxel_core::net::{connect_tcp, tls_connect};

use crate::client::{SieveConnector, SieveStream};

/// Délai d'établissement de la connexion et de la négociation TLS.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Connexion TCP en clair d'avant STARTTLS. Le client ne la voit que comme un `SieveStream` : quand `upgrade` la
/// lâche, elle dépose sa socket dans `slot`, où la négociation TLS la reprend.
struct PlainTcp {
    inner: Option<TcpStream>,
    slot: Arc<Mutex<Option<TcpStream>>>,
}

impl Drop for PlainTcp {
    fn drop(&mut self) {
        if let Some(stream) = self.inner.take() {
            *self.slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(stream);
        }
    }
}

fn closed() -> std::io::Error {
    std::io::Error::from(std::io::ErrorKind::NotConnected)
}

impl AsyncRead for PlainTcp {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.inner.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            None => std::task::Poll::Ready(Err(closed())),
        }
    }
}

impl AsyncWrite for PlainTcp {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.inner.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            None => std::task::Poll::Ready(Err(closed())),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.inner.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_flush(cx),
            None => std::task::Poll::Ready(Err(closed())),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.inner.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            None => std::task::Poll::Ready(Err(closed())),
        }
    }
}

fn io_error(e: voxel_core::net::NetError) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

pub(crate) fn connector(ep: &Endpoint) -> SieveConnector {
    let slot: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));
    let (host, port, secure) = (ep.host.clone(), ep.port, ep.secure);
    let connect_slot = slot.clone();
    let connect_host = host.clone();
    let connect = Box::new(move || {
        let host = connect_host.clone();
        let slot = connect_slot.clone();
        Box::pin(async move {
            let tcp = connect_tcp(&host, port, CONNECT_TIMEOUT)
                .await
                .map_err(io_error)?;
            if secure {
                let tls = tls_connect(tcp, &host, CONNECT_TIMEOUT)
                    .await
                    .map_err(io_error)?;
                return Ok(Box::new(tls) as Box<dyn SieveStream>);
            }
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(Box::new(PlainTcp {
                inner: Some(tcp),
                slot,
            }) as Box<dyn SieveStream>)
        }) as futures_util::future::BoxFuture<'static, _>
    });
    if secure {
        return SieveConnector {
            connect,
            upgrade: None,
        };
    }
    SieveConnector {
        connect,
        upgrade: Some(Arc::new(move |raw: Box<dyn SieveStream>| {
            let host = host.clone();
            let slot = slot.clone();
            Box::pin(async move {
                drop(raw);
                let tcp = slot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take()
                    .ok_or_else(closed)?;
                let tls = tls_connect(tcp, &host, CONNECT_TIMEOUT)
                    .await
                    .map_err(io_error)?;
                Ok(Box::new(tls) as Box<dyn SieveStream>)
            }) as futures_util::future::BoxFuture<'static, _>
        })),
    }
}
