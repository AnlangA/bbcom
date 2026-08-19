//! Transport/file boundary for non-WIT embedders and protocol tests.
//!
//! The production guest implements the equivalent `bbcom-plugin-sdk` traits
//! with opaque v2 host resources. Keeping this core boundary byte-oriented
//! prevents native serial or filesystem APIs from leaking into the no-WASI
//! component or alternate embedded users.

use alloc::vec::Vec;

/// Minimal byte transport needed by an MCUmgr transaction.
///
/// Timeouts and cancellation are host concepts and are represented by the
/// adapter's error type rather than by clocks inside this crate.
pub trait ByteTransport {
    type Error;

    /// Write the complete encoded request under an active serial lease.
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error>;

    /// Return the next bounded RX chunk. An empty chunk is not EOF; the host
    /// adapter decides whether that means timeout, cancellation, or progress.
    fn read_chunk(&mut self, max_len: usize) -> Result<Vec<u8>, Self::Error>;
}

/// Random-access read grant used by future streaming firmware/file commands.
pub trait ReadGrant {
    type Error;

    fn len(&self) -> u64;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Vec<u8>, Self::Error>;
}

/// Transactional save grant. `commit` is the only operation allowed to make
/// the host-selected destination visible.
pub trait SaveGrant {
    type Error;

    fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), Self::Error>;
    fn commit(self) -> Result<(), Self::Error>;
}
