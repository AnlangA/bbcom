//! Native-only managed `.bbcom` project container operations.
//!
//! Managed locations are derived exclusively from validated workspace UUIDs.
//! External paths are opaque Rust types constructed by the native picker/file
//! grant layer and never serialized into the WebView.

mod atomic;
mod cancellation;
mod encryption;
mod error;
mod legacy_backup;
mod library;
mod path;

pub use cancellation::{CancellationCheck, ContainerCheckpoint, NeverCancel};
pub use encryption::{
    AGE_CRATE_VERSION_REQUIRED, AGE_SCRYPT_ENVELOPE, AgeScryptEnvelope, AgeScryptPassphraseStreams,
};
pub use error::{ProjectContainerError, ProjectContainerResult};
pub use legacy_backup::{
    LegacyBackupFile, verify_encrypted_legacy_backup, write_encrypted_legacy_backup,
};
pub use library::{ExportedProject, ImportedProject, ProjectLibrary};
pub use path::{
    BBCOM_PROJECT_EXTENSION, ManagedProjectFileName, NativeProjectDestination, NativeProjectSource,
    WorkspaceUuid,
};

pub const MAX_PROJECT_CONTAINER_BYTES: u64 = 512 * 1024 * 1024;
