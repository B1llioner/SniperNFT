use alloy_primitives::{Address, B256, keccak256};
use anyhow::{Result, ensure};
use serde_json::Value;

pub fn quantity(value: &Value) -> Result<u128> {
    let s = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("RPC quantity is not a string"))?;
    let digits = s
        .strip_prefix("0x")
        .ok_or_else(|| anyhow::anyhow!("RPC quantity has no prefix"))?;
    ensure!(
        !digits.is_empty() && digits.len() <= 32 && (digits.len() == 1 || !digits.starts_with('0')),
        "Noncanonical RPC quantity"
    );
    Ok(u128::from_str_radix(digits, 16)?)
}

pub fn quantity64(value: &Value) -> Result<u64> {
    Ok(u64::try_from(quantity(value)?)?)
}

pub fn hex(data: &[u8]) -> String {
    format!("0x{}", alloy_primitives::hex::encode(data))
}

pub fn bytes(value: &Value) -> Result<Vec<u8>> {
    let s = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("RPC data is not a string"))?;
    let digits = s
        .strip_prefix("0x")
        .ok_or_else(|| anyhow::anyhow!("RPC data has no prefix"))?;
    ensure!(
        digits.len() <= 4 * 1024 * 1024 && digits.len() % 2 == 0,
        "Invalid RPC data length"
    );
    alloy_primitives::hex::decode(digits).map_err(|_| anyhow::anyhow!("Invalid RPC hex data"))
}

pub fn word(value: u128) -> [u8; 32] {
    let mut result = [0; 32];
    result[16..].copy_from_slice(&value.to_be_bytes());
    result
}

pub fn address_word(value: Address) -> [u8; 32] {
    let mut result = [0; 32];
    result[12..].copy_from_slice(value.as_slice());
    result
}

pub fn decode_word(bytes: &[u8]) -> Result<u128> {
    ensure!(
        bytes.len() == 32 && bytes[..16].iter().all(|v| *v == 0),
        "ABI integer exceeds supported range"
    );
    Ok(u128::from_be_bytes(bytes[16..].try_into()?))
}

pub fn call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    let mut result = keccak256(signature.as_bytes())[..4].to_vec();
    for word in words {
        result.extend_from_slice(word);
    }
    result
}

pub fn hash(value: &Value) -> Result<B256> {
    let s = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("RPC hash is not a string"))?;
    s.parse().map_err(|_| anyhow::anyhow!("Invalid RPC hash"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn strict_quantities_and_abi() -> Result<()> {
        assert_eq!(quantity(&json!("0x1237"))?, 4663);
        for q in ["", "1", "0x", "0x01", "0x-1"] {
            assert!(quantity(&json!(q)).is_err());
        }
        assert_eq!(
            hex(&call("balanceOf(address)", &[address_word(Address::ZERO)]))[..10],
            *"0x70a08231"
        );
        assert_eq!(decode_word(&word(u128::MAX))?, u128::MAX);
        assert!(decode_word(&[255; 32]).is_err());
        Ok(())
    }
}
