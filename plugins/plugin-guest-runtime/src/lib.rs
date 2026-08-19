//! Runtime support shared by no-std BBCOM guest Components.

#![no_std]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(target_arch = "wasm32")]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::ptr::{addr_of_mut, copy_nonoverlapping, null_mut};
    use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    // The host limit is 64 MiB. This leaves room for code, canonical-ABI
    // stacks, and static data while allowing bounded workflows to reuse heap.
    const ARENA_BYTES: usize = 40 * 1024 * 1024;
    const FREE_SLOTS: usize = 4_096;

    #[repr(C, align(65536))]
    struct Arena([u8; ARENA_BYTES]);

    #[derive(Clone, Copy)]
    struct FreeBlock {
        offset: usize,
        size: usize,
        occupied: bool,
    }

    const EMPTY: FreeBlock = FreeBlock {
        offset: 0,
        size: 0,
        occupied: false,
    };

    static mut ARENA: Arena = Arena([0; ARENA_BYTES]);
    static mut FREE: [FreeBlock; FREE_SLOTS] = [EMPTY; FREE_SLOTS];
    static CURSOR: AtomicUsize = AtomicUsize::new(0);
    static LOCK: AtomicBool = AtomicBool::new(false);

    struct WasmAllocator;
    struct Guard;

    impl Guard {
        fn acquire() -> Self {
            while LOCK
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                core::hint::spin_loop();
            }
            Self
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            LOCK.store(false, Ordering::Release);
        }
    }

    unsafe impl GlobalAlloc for WasmAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if layout.size() == 0 {
                return layout.align() as *mut u8;
            }
            let _guard = Guard::acquire();
            // SAFETY: the arena address is accessed only while holding LOCK.
            let arena = unsafe { addr_of_mut!(ARENA.0).cast::<u8>() };
            let free = addr_of_mut!(FREE).cast::<FreeBlock>();
            for index in 0..FREE_SLOTS {
                // SAFETY: metadata access is serialized and the index is bounded.
                let block = unsafe { free.add(index) };
                // SAFETY: `block` points to one initialized metadata slot.
                let value = unsafe { *block };
                if value.occupied
                    && value.size >= layout.size()
                    && value.offset.is_multiple_of(layout.align())
                {
                    // SAFETY: the same lock protects this metadata update.
                    unsafe { (*block).occupied = false };
                    // SAFETY: stored blocks always refer to this arena.
                    return unsafe { arena.add(value.offset) };
                }
            }

            let cursor = CURSOR.load(Ordering::Relaxed);
            let Some(aligned) = align_up(cursor, layout.align()) else {
                return null_mut();
            };
            let Some(end) = aligned.checked_add(layout.size()) else {
                return null_mut();
            };
            if end > ARENA_BYTES {
                return null_mut();
            }
            CURSOR.store(end, Ordering::Relaxed);
            // SAFETY: `aligned..end` is within the arena and newly assigned.
            unsafe { arena.add(aligned) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            if layout.size() == 0 || pointer.is_null() {
                return;
            }
            let _guard = Guard::acquire();
            // SAFETY: the arena address is accessed only while holding LOCK.
            let arena = unsafe { addr_of_mut!(ARENA.0).cast::<u8>() };
            let base = arena as usize;
            let address = pointer as usize;
            if address < base
                || address
                    .checked_add(layout.size())
                    .is_none_or(|end| end > base + ARENA_BYTES)
            {
                return;
            }
            let free = addr_of_mut!(FREE).cast::<FreeBlock>();
            for index in 0..FREE_SLOTS {
                // SAFETY: metadata access is serialized and the index is bounded.
                let block = unsafe { free.add(index) };
                // SAFETY: `block` points to one initialized metadata slot.
                if !unsafe { (*block).occupied } {
                    // SAFETY: the same lock protects this metadata update.
                    unsafe {
                        *block = FreeBlock {
                            offset: address - base,
                            size: layout.size(),
                            occupied: true,
                        };
                    }
                    return;
                }
            }
            // Exhausting metadata leaks this allocation instead of corrupting
            // the heap. Bounded guest workflows reuse far fewer shapes.
        }
    }

    const fn align_up(value: usize, alignment: usize) -> Option<usize> {
        let mask = alignment.wrapping_sub(1);
        match value.checked_add(mask) {
            Some(value) => Some(value & !mask),
            None => None,
        }
    }

    #[global_allocator]
    static GLOBAL: WasmAllocator = WasmAllocator;

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn cabi_realloc(
        old: *mut u8,
        old_len: usize,
        alignment: usize,
        new_len: usize,
    ) -> *mut u8 {
        let Ok(new_layout) = Layout::from_size_align(new_len, alignment.max(1)) else {
            return null_mut();
        };
        // SAFETY: canonical ABI supplies the requested layout.
        let new = unsafe { GlobalAlloc::alloc(&GLOBAL, new_layout) };
        if !new.is_null() && !old.is_null() && old_len != 0 {
            // SAFETY: canonical ABI supplies valid disjoint allocations.
            unsafe { copy_nonoverlapping(old, new, old_len.min(new_len)) };
            if let Ok(old_layout) = Layout::from_size_align(old_len, alignment.max(1)) {
                // SAFETY: canonical ABI supplied this old allocation and layout.
                unsafe { GlobalAlloc::dealloc(&GLOBAL, old, old_layout) };
            }
        }
        new
    }

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
        core::arch::wasm32::unreachable()
    }

    /// LLVM may lower equality to the C ABI even in a no-std guest.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn memcmp(left: *const u8, right: *const u8, length: usize) -> i32 {
        for index in 0..length {
            // SAFETY: LLVM supplies two readable regions of `length` bytes.
            let left = unsafe { *left.add(index) };
            // SAFETY: LLVM supplies two readable regions of `length` bytes.
            let right = unsafe { *right.add(index) };
            if left != right {
                return i32::from(left) - i32::from(right);
            }
        }
        0
    }
}
