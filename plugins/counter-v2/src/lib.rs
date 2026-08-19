//! Small but complete `bbcom:plugin@2` guest example.

#![cfg_attr(target_arch = "wasm32", no_std)]
#![deny(unsafe_op_in_unsafe_fn)]

extern crate alloc;

#[cfg(target_arch = "wasm32")]
use bbcom_plugin_guest_runtime as _;

pub mod model;
pub mod surface;
pub mod workflow;

#[cfg(feature = "component")]
mod component;
