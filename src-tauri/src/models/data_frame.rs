use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataFrame {
    pub id: String,
    pub direction: Direction,
    pub timestamp: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Direction {
    Tx,
    Rx,
}
