//! BBCOM plugin-v2 MCUmgr guest.
//!
//! The reusable model/workflow modules depend only on `alloc`, the protocol
//! core, and `bbcom-plugin-sdk` authority traits. `component` adds the generated
//! WIT adapter; no module opens a serial port, filesystem path, socket,
//! process, or environment variable.

#![cfg_attr(target_arch = "wasm32", no_std)]
#![deny(unsafe_op_in_unsafe_fn)]

extern crate alloc;

// Links the bounded allocator, canonical ABI realloc, panic handler, and
// compiler intrinsics without granting any ambient authority.
#[cfg(target_arch = "wasm32")]
use bbcom_plugin_guest_runtime as _;

pub mod model;
pub mod raw_input;
pub mod sha256;
pub mod surfaces;
pub mod workflow;

#[cfg(feature = "component")]
mod component;
