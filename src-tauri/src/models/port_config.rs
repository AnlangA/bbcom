use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortConfig {
    pub baud_rate: u32,
    pub data_bits: DataBits,
    pub stop_bits: StopBits,
    pub parity: Parity,
    pub flow_control: FlowControl,
}

#[derive(Debug, Clone, Copy)]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

impl Serialize for DataBits {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(match self {
            Self::Five => 5,
            Self::Six => 6,
            Self::Seven => 7,
            Self::Eight => 8,
        })
    }
}

impl<'de> Deserialize<'de> for DataBits {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let n = u8::deserialize(deserializer)?;
        Ok(match n {
            5 => Self::Five,
            6 => Self::Six,
            7 => Self::Seven,
            _ => Self::Eight,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub enum StopBits {
    One,
    Two,
}

impl Serialize for StopBits {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(match self {
            Self::One => 1,
            Self::Two => 2,
        })
    }
}

impl<'de> Deserialize<'de> for StopBits {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let n = u8::deserialize(deserializer)?;
        Ok(match n {
            2 => Self::Two,
            _ => Self::One,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}
