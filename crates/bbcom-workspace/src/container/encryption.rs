use std::io::{Read, Write};

use age::secrecy::SecretString;
use age::{Decryptor, Encryptor};

use super::cancellation::check_cancelled;
use super::{
    CancellationCheck, ContainerCheckpoint, ProjectContainerError, ProjectContainerResult,
};

const STREAM_BUFFER_BYTES: usize = 64 * 1024;

/// The encrypted form is the standard age file format with its standard
/// scrypt passphrase recipient. No bbcom-specific password envelope exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgeScryptEnvelope {
    pub format: &'static str,
    pub recipient: &'static str,
    pub media_type: &'static str,
    pub maximum_ciphertext_bytes: u64,
    pub maximum_plaintext_bytes: u64,
}

pub const AGE_CRATE_VERSION_REQUIRED: &str = "0.12.1";
pub const AGE_SCRYPT_ENVELOPE: AgeScryptEnvelope = AgeScryptEnvelope {
    format: "age",
    recipient: "scrypt",
    media_type: "application/vnd.bbcom.project+sqlite3",
    maximum_ciphertext_bytes: super::MAX_PROJECT_CONTAINER_BYTES,
    maximum_plaintext_bytes: super::MAX_PROJECT_CONTAINER_BYTES,
};

/// Native-only passphrase stream. The passphrase is held by age's secrecy
/// wrapper, is never serializable, and is used only with the standard age
/// scrypt recipient/identity pair.
pub struct AgeScryptPassphraseStreams {
    passphrase: SecretString,
}

impl AgeScryptPassphraseStreams {
    pub fn new(passphrase: String) -> ProjectContainerResult<Self> {
        if passphrase.is_empty() {
            return Err(ProjectContainerError::InvalidInput {
                field: "passphrase",
            });
        }
        Ok(Self {
            passphrase: SecretString::from(passphrase),
        })
    }

    #[must_use]
    pub const fn envelope(&self) -> AgeScryptEnvelope {
        AGE_SCRYPT_ENVELOPE
    }

    pub fn encrypt(
        &self,
        plaintext: &mut dyn Read,
        ciphertext: &mut dyn Write,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<()> {
        check_cancelled(cancellation, ContainerCheckpoint::EncryptStream)?;
        let encryptor = Encryptor::with_user_passphrase(self.passphrase.clone());
        let mut bounded_ciphertext = BoundedWriter::new(ciphertext);
        let writer = encryptor
            .wrap_output(&mut bounded_ciphertext)
            .map_err(map_encryption_io)?;
        let mut writer = writer;
        copy_stream_bounded(
            plaintext,
            &mut writer,
            "databaseBytes",
            ContainerCheckpoint::EncryptStream,
            cancellation,
        )?;
        writer.finish().map_err(map_encryption_io)?;
        Ok(())
    }

    pub fn decrypt(
        &self,
        ciphertext: &mut dyn Read,
        plaintext: &mut dyn Write,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<u64> {
        check_cancelled(cancellation, ContainerCheckpoint::DecryptStream)?;
        let decryptor = Decryptor::new(ciphertext).map_err(|_| ProjectContainerError::AgeStream)?;
        if !decryptor.is_scrypt() {
            return Err(ProjectContainerError::AgeStream);
        }
        let identity = age::scrypt::Identity::new(self.passphrase.clone());
        let mut reader = decryptor
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .map_err(|_| ProjectContainerError::AgeStream)?;
        copy_stream_bounded(
            &mut reader,
            plaintext,
            "decryptedBytes",
            ContainerCheckpoint::DecryptStream,
            cancellation,
        )
        .map_err(|error| match error {
            ProjectContainerError::AgeIo(_) => ProjectContainerError::AgeStream,
            other => other,
        })
    }
}

struct BoundedWriter<'a> {
    inner: &'a mut dyn Write,
    bytes: u64,
}

impl<'a> BoundedWriter<'a> {
    const fn new(inner: &'a mut dyn Write) -> Self {
        Self { inner, bytes: 0 }
    }
}

impl Write for BoundedWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let projected = self
            .bytes
            .checked_add(buffer.len() as u64)
            .ok_or_else(encrypted_limit_io_error)?;
        if projected > super::MAX_PROJECT_CONTAINER_BYTES {
            return Err(encrypted_limit_io_error());
        }
        let written = self.inner.write(buffer)?;
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn encrypted_limit_io_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::FileTooLarge, "encryptedFileBytes")
}

fn map_encryption_io(error: std::io::Error) -> ProjectContainerError {
    if error.kind() == std::io::ErrorKind::FileTooLarge {
        ProjectContainerError::LimitExceeded {
            field: "encryptedFileBytes",
            limit: super::MAX_PROJECT_CONTAINER_BYTES,
            actual: super::MAX_PROJECT_CONTAINER_BYTES.saturating_add(1),
        }
    } else {
        ProjectContainerError::AgeIo(error)
    }
}

fn copy_stream_bounded(
    source: &mut dyn Read,
    destination: &mut dyn Write,
    field: &'static str,
    checkpoint: ContainerCheckpoint,
    cancellation: &(impl CancellationCheck + ?Sized),
) -> ProjectContainerResult<u64> {
    let mut buffer = [0_u8; STREAM_BUFFER_BYTES];
    let mut copied = 0_u64;
    loop {
        check_cancelled(cancellation, checkpoint)?;
        let count = source
            .read(&mut buffer)
            .map_err(ProjectContainerError::AgeIo)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or(ProjectContainerError::LimitExceeded {
                field,
                limit: super::MAX_PROJECT_CONTAINER_BYTES,
                actual: u64::MAX,
            })?;
        ensure_stream_limit(field, copied)?;
        destination
            .write_all(&buffer[..count])
            .map_err(ProjectContainerError::AgeIo)?;
    }
    destination.flush().map_err(ProjectContainerError::AgeIo)?;
    Ok(copied)
}

fn ensure_stream_limit(field: &'static str, actual: u64) -> ProjectContainerResult<()> {
    if actual > super::MAX_PROJECT_CONTAINER_BYTES {
        Err(ProjectContainerError::LimitExceeded {
            field,
            limit: super::MAX_PROJECT_CONTAINER_BYTES,
            actual,
        })
    } else {
        Ok(())
    }
}
