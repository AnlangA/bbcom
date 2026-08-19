#![no_std]
#![forbid(unsafe_code)]
#![doc = "Guest-side, ambient-authority-free helpers for bbcom plugin protocol v2."]

extern crate alloc;

pub mod capability;
pub mod error;
pub mod file;
pub mod limits;
pub mod model;
pub mod resource;
pub mod serial;
pub mod state;
pub mod task;
pub mod ui;

pub use capability::Capability;
pub use error::{ContractError, Result};
pub use limits::{MinorRange, ResourceLimits, negotiate_minor};
