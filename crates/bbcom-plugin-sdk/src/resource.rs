use alloc::string::String;
use core::marker::PhantomData;

/// Identity attached to every host-owned v2 resource. The host is authoritative
/// and rejects a binding after a workspace, instance, or generation change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceBinding {
    pub workspace_id: String,
    pub plugin_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub resource_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundResource<T> {
    binding: ResourceBinding,
    marker: PhantomData<fn() -> T>,
}

impl<T> BoundResource<T> {
    #[must_use]
    pub fn new(binding: ResourceBinding) -> Self {
        Self {
            binding,
            marker: PhantomData,
        }
    }

    #[must_use]
    pub const fn binding(&self) -> &ResourceBinding {
        &self.binding
    }

    #[must_use]
    pub fn into_binding(self) -> ResourceBinding {
        self.binding
    }
}
