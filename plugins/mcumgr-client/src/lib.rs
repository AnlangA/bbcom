//! Transport-independent MCUmgr/SMP protocol core for the BBCOM plugin.
//!
//! This crate deliberately owns no I/O. The host adapter is responsible for
//! serial leases, reads, writes, clocks, cancellation, files, and UI.

#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

#[cfg(feature = "std")]
extern crate std;

pub mod adapter;
pub mod base64;
pub mod cbor;
pub mod command;
pub mod console;
pub mod crc;
pub mod error;
pub mod raw;
pub mod smp;

pub use command::{Command, CommandMeta, Risk};
pub use console::{ConsoleCodec, ConsoleParser, DEFAULT_CONSOLE_FRAME_SIZE};
pub use error::{CborError, ProtocolError};
pub use raw::RawParser;
pub use smp::{Header, Op, Packet, PendingRequest, Sequence, Version, HEADER_LEN};
