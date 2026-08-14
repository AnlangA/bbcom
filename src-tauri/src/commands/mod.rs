pub mod ai;
pub mod checksum;
pub mod export;
pub mod file_grants;
pub mod legacy_backup;
pub mod legacy_reset;
pub mod log;
pub mod plugin;
pub mod serial_drain;
pub mod shutdown;
pub mod window;
pub mod workspace;

#[cfg(test)]
mod ipc_contracts;
#[cfg(test)]
mod window_contracts;
