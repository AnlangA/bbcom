//! bbcom counter panel plugin.
//!
//! A deliberately small but complete example of the `bbcom:plugin/plugin@1.0.0`
//! world: it renders a declarative panel with the number of "bump" button
//! presses, persists that counter through the sandboxed `plugin.storage` host
//! import, and republishes the panel through `publish-panel` after every
//! event. The guest is `no_std` on purpose — the bbcom host links no WASI, so
//! the component must not import any wasi interface.

#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use core::sync::atomic::{AtomicU64, Ordering};

wit_bindgen::generate!({ path: "../../wit/bbcom-plugin-v1", std_feature });

use bbcom::plugin::host;
use bbcom::plugin::types::FieldKind;
use bbcom::plugin::types::PanelField;

static COUNTER: AtomicU64 = AtomicU64::new(0);

const STORAGE_KEY: &str = "counter";
const STORAGE_UNAVAILABLE: &str = "plugin storage unavailable";


/// Minimal bump allocator over a static arena. The counter plugin allocates
/// only small, bounded panels per event and its lifetime is one host process;
/// freeing is a no-op and the arena is large enough that exhaustion would
/// surface as a guest trap (fail closed) long after abnormal usage.
struct BumpAllocator;

const ARENA_SIZE: usize = 256 * 1024;
static mut ARENA: [u8; ARENA_SIZE] = [0; ARENA_SIZE];
static ARENA_CURSOR: AtomicU64 = AtomicU64::new(0);

unsafe impl core::alloc::GlobalAlloc for BumpAllocator {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let align = layout.align().max(1) as u64;
        let size = layout.size() as u64;
        let base = ARENA_CURSOR.fetch_add(0, Ordering::Relaxed);
        let aligned = base.div_ceil(align) * align;
        let next = aligned + size;
        if next > ARENA_SIZE as u64 {
            return core::ptr::null_mut();
        }
        ARENA_CURSOR.store(next, Ordering::Release);
        unsafe { ARENA.as_mut_ptr().add(aligned as usize) }
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {}
}

#[global_allocator]
static GLOBAL: BumpAllocator = BumpAllocator;

/// Components on wasm32-wasip2 must export the canonical-ABI realloc; the
/// Rust standard library normally provides it, so this no_std guest exports
/// its own on top of the bump allocator (old allocations are intentionally
/// retained; see BumpAllocator).
#[no_mangle]
pub unsafe extern "C" fn cabi_realloc(
    old: *mut u8,
    old_len: usize,
    align: usize,
    new_len: usize,
) -> *mut u8 {
    unsafe {
        let layout = core::alloc::Layout::from_size_align_unchecked(new_len, align.max(1));
        let new = core::alloc::GlobalAlloc::alloc(&GLOBAL, layout);
        if !new.is_null() && !old.is_null() && old_len > 0 {
            core::ptr::copy_nonoverlapping(old, new, old_len.min(new_len));
        }
        new
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    // panic=abort in release; this handler exists only so the no_std cdylib
    // links without a Rust standard panic runtime (and without WASI).
    unreachable!()
}

fn read_counter() -> Result<u64, String> {
    match host::storage_get(STORAGE_KEY) {
        Ok(Some(bytes)) => core::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| "stored counter is corrupt".to_string()),
        Ok(None) => Ok(0),
        Err(_) => Err(STORAGE_UNAVAILABLE.to_string()),
    }
}

fn write_counter(value: u64) -> Result<(), String> {
    host::storage_set(STORAGE_KEY, &value.to_string().into_bytes())
        .map_err(|_| STORAGE_UNAVAILABLE.to_string())
}

fn session_count() -> Result<u64, String> {
    host::session_list()
        .map(|sessions| sessions.len() as u64)
        .map_err(|_| "session metadata unavailable".to_string())
}

fn panel_for(value: u64) -> DeclarativePanel {
    DeclarativePanel {
        title: "Serial counter".to_string(),
        fields: Vec::from([
            PanelField {
                id: "count".to_string(),
                label: "Button presses".to_string(),
                kind: FieldKind::Number,
                value: value.to_string(),
                options: Vec::new(),
                disabled: false,
            },
            PanelField {
                id: "sessions".to_string(),
                label: "Open sessions".to_string(),
                kind: FieldKind::Number,
                value: session_count().unwrap_or(0).to_string(),
                options: Vec::new(),
                disabled: false,
            },
            PanelField {
                id: "bump".to_string(),
                label: "Count one frame".to_string(),
                kind: FieldKind::Button,
                value: String::new(),
                options: Vec::new(),
                disabled: false,
            },
            PanelField {
                id: "reset".to_string(),
                label: "Reset counter".to_string(),
                kind: FieldKind::Button,
                value: String::new(),
                options: Vec::new(),
                disabled: false,
            },
        ]),
    }
}

struct CounterPanelPlugin;

impl Guest for CounterPanelPlugin {
    fn initialize() -> Result<DeclarativePanel, String> {
        let value = read_counter()?;
        let sessions = session_count()?;
        COUNTER.store(value, Ordering::Relaxed);
        let mut panel = panel_for(value);
        panel.fields[1].value = sessions.to_string();
        Ok(panel)
    }

    fn handle_panel_event(event: PanelEvent) -> Result<DeclarativePanel, String> {
        let next = match event.field_id.as_str() {
            "bump" => COUNTER.fetch_add(1, Ordering::Relaxed).saturating_add(1),
            "reset" => {
                COUNTER.store(0, Ordering::Relaxed);
                0
            }
            // Unknown fields leave the panel unchanged; the host re-renders
            // the returned panel verbatim.
            _ => COUNTER.load(Ordering::Relaxed),
        };
        write_counter(next)?;
        let panel = panel_for(next);
        // The panel return value renders in the active session; publish-panel
        // additionally refreshes any other surface bound to this plugin.
        host::publish_panel(&panel).map_err(|_| "panel publish unavailable".to_string())?;
        Ok(panel)
    }

    fn shutdown() {}
}

export!(CounterPanelPlugin);
