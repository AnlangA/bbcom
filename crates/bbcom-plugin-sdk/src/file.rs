use alloc::string::String;
use alloc::vec::Vec;

use crate::limits::MAX_STREAM_CHUNK_BYTES;
use crate::{ContractError, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadGrantInfo {
    pub display_name: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveGrantInfo {
    pub display_name: String,
}

/// A host-provided, non-persistable read grant. No native path is exposed.
pub trait ReadGrant {
    fn info(&self) -> ReadGrantInfo;
    fn read_at(&mut self, offset: u64, max_bytes: u32) -> Result<Vec<u8>>;
    fn close(&mut self);
}

/// A host-provided atomic save grant. Dropping without commit must be treated
/// by the host as cancellation and must not create the selected target file.
pub trait SaveGrant {
    fn info(&self) -> SaveGrantInfo;
    fn write(&mut self, payload: &[u8]) -> Result<u64>;
    fn commit(&mut self) -> Result<()>;
    fn cancel(&mut self);
}

pub struct ChunkedReader<G> {
    grant: G,
    chunk_bytes: usize,
}

impl<G: ReadGrant> ChunkedReader<G> {
    pub fn new(grant: G, chunk_bytes: usize) -> Result<Self> {
        if chunk_bytes == 0 || chunk_bytes > MAX_STREAM_CHUNK_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        Ok(Self { grant, chunk_bytes })
    }

    #[must_use]
    pub const fn grant(&self) -> &G {
        &self.grant
    }

    pub fn read_exact_at(&mut self, mut offset: u64, mut output: &mut [u8]) -> Result<()> {
        while !output.is_empty() {
            let request = output.len().min(self.chunk_bytes);
            let chunk = self.grant.read_at(offset, request as u32)?;
            if chunk.is_empty() || chunk.len() > request {
                return Err(ContractError::IoError);
            }
            let count = chunk.len();
            output[..count].copy_from_slice(&chunk);
            output = &mut output[count..];
            offset = offset
                .checked_add(count as u64)
                .ok_or(ContractError::InvalidInput)?;
        }
        Ok(())
    }

    /// Visits a file one bounded chunk at a time. This supports multi-pass hash
    /// and MCUboot parsing without loading the whole firmware into Wasm memory.
    pub fn for_each_chunk<F>(&mut self, mut visitor: F) -> Result<()>
    where
        F: FnMut(u64, &[u8]) -> Result<()>,
    {
        let size = self.grant.info().size;
        let mut offset = 0_u64;
        while offset < size {
            let remaining = size - offset;
            let request = remaining.min(self.chunk_bytes as u64) as u32;
            let chunk = self.grant.read_at(offset, request)?;
            if chunk.is_empty() || chunk.len() > request as usize {
                return Err(ContractError::IoError);
            }
            visitor(offset, &chunk)?;
            offset = offset
                .checked_add(chunk.len() as u64)
                .ok_or(ContractError::InvalidInput)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn into_inner(self) -> G {
        self.grant
    }
}

pub struct ChunkedWriter<G> {
    grant: G,
    chunk_bytes: usize,
}

impl<G: SaveGrant> ChunkedWriter<G> {
    pub fn new(grant: G, chunk_bytes: usize) -> Result<Self> {
        if chunk_bytes == 0 || chunk_bytes > MAX_STREAM_CHUNK_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        Ok(Self { grant, chunk_bytes })
    }

    pub fn write_all(&mut self, payload: &[u8]) -> Result<()> {
        for chunk in payload.chunks(self.chunk_bytes) {
            let accepted = self.grant.write(chunk)?;
            if accepted != chunk.len() as u64 {
                return Err(ContractError::PartialWrite);
            }
        }
        Ok(())
    }

    pub fn commit(&mut self) -> Result<()> {
        self.grant.commit()
    }

    pub fn cancel(&mut self) {
        self.grant.cancel();
    }

    #[must_use]
    pub fn into_inner(self) -> G {
        self.grant
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemoryReadGrant {
        bytes: Vec<u8>,
        largest_request: u32,
    }

    impl ReadGrant for MemoryReadGrant {
        fn info(&self) -> ReadGrantInfo {
            ReadGrantInfo {
                display_name: "firmware.bin".into(),
                size: self.bytes.len() as u64,
            }
        }

        fn read_at(&mut self, offset: u64, max_bytes: u32) -> Result<Vec<u8>> {
            self.largest_request = self.largest_request.max(max_bytes);
            let start = offset as usize;
            let end = self
                .bytes
                .len()
                .min(start.saturating_add(max_bytes as usize));
            if start > end {
                return Err(ContractError::InvalidInput);
            }
            Ok(Vec::from(&self.bytes[start..end]))
        }

        fn close(&mut self) {}
    }

    struct MemorySaveGrant {
        bytes: Vec<u8>,
        committed: bool,
    }

    impl SaveGrant for MemorySaveGrant {
        fn info(&self) -> SaveGrantInfo {
            SaveGrantInfo {
                display_name: "capture.bin".into(),
            }
        }

        fn write(&mut self, payload: &[u8]) -> Result<u64> {
            self.bytes.extend_from_slice(payload);
            Ok(payload.len() as u64)
        }

        fn commit(&mut self) -> Result<()> {
            self.committed = true;
            Ok(())
        }

        fn cancel(&mut self) {
            self.bytes.clear();
        }
    }

    #[test]
    fn read_grants_are_visited_in_bounded_chunks() {
        let grant = MemoryReadGrant {
            bytes: (0_u8..10).collect(),
            largest_request: 0,
        };
        let mut reader = ChunkedReader::new(grant, 3).unwrap();
        let mut observed = Vec::new();
        reader
            .for_each_chunk(|_, chunk| {
                observed.extend_from_slice(chunk);
                Ok(())
            })
            .unwrap();
        assert_eq!(observed, (0_u8..10).collect::<Vec<_>>());
        assert_eq!(reader.grant().largest_request, 3);
    }

    #[test]
    fn save_grants_commit_only_after_all_chunks_are_accepted() {
        let grant = MemorySaveGrant {
            bytes: Vec::new(),
            committed: false,
        };
        let mut writer = ChunkedWriter::new(grant, 2).unwrap();
        writer.write_all(&[1, 2, 3, 4, 5]).unwrap();
        writer.commit().unwrap();
        let grant = writer.into_inner();
        assert_eq!(grant.bytes, [1, 2, 3, 4, 5]);
        assert!(grant.committed);
    }
}
