pub mod ai;
pub mod checksum;
pub mod export;
pub mod file_grants;
pub mod log;
pub mod mcumgr;
pub mod serial_drain;
pub mod shutdown;
pub(crate) mod streaming_sessions;
pub mod window;
pub mod workspace;

#[cfg(test)]
mod ipc_contracts;
#[cfg(test)]
mod window_contracts;
