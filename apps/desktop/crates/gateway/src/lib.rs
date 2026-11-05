//! Les routes /imap/* de Voxel, servies dans le processus de l'appli : la même passerelle sans état que le serveur Node (chaque requête porte ses identifiants et ses serveurs), sans socket.

mod blobs;
mod discovery;
mod pool;
mod ratelimit;
mod routes;
mod sse;
mod target;

pub use routes::{Gateway, KvProvider};
