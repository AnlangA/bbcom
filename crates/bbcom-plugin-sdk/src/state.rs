use alloc::vec::Vec;

use crate::Result;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigratedState {
    pub schema_version: u32,
    pub payload: Vec<u8>,
}

impl MigratedState {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version == 0 {
            Err(crate::ContractError::InvalidInput)
        } else {
            Ok(())
        }
    }
}

pub trait PluginStorage {
    fn get(&mut self, key: &str) -> Result<Option<Vec<u8>>>;
    fn set(&mut self, key: &str, value: &[u8]) -> Result<()>;
    fn delete(&mut self, key: &str) -> Result<()>;
}

pub trait ProjectState {
    fn get(&mut self) -> Result<Option<MigratedState>>;
    fn set(&mut self, state: &MigratedState) -> Result<()>;
}

/// Runs migration before persistence. If migration fails, `persist` is never
/// called, so callers can keep the previous state intact.
pub fn migrate_transactionally<M, P>(
    previous_api: &str,
    previous: &[u8],
    migrate: M,
    persist: P,
) -> Result<MigratedState>
where
    M: FnOnce(&str, &[u8]) -> Result<MigratedState>,
    P: FnOnce(&MigratedState) -> Result<()>,
{
    let migrated = migrate(previous_api, previous)?;
    migrated.validate()?;
    persist(&migrated)?;
    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ContractError;

    #[test]
    fn migration_rejects_schema_zero_before_persistence() {
        let mut persisted = false;
        let result = migrate_transactionally(
            "bbcom:plugin@2.0.0",
            b"old",
            |_, _| {
                Ok(MigratedState {
                    schema_version: 0,
                    payload: b"new".to_vec(),
                })
            },
            |_| {
                persisted = true;
                Ok(())
            },
        );
        assert_eq!(result, Err(ContractError::InvalidInput));
        assert!(!persisted);
    }
}
