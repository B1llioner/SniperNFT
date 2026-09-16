use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};

use rust_mint_benchmark::eth;

pub struct Artifact {
    pub name: &'static str,
    pub init: Vec<u8>,
    runtime: Vec<u8>,
    references: BTreeMap<String, Vec<usize>>,
    pub start_time_slot: Option<String>,
}

impl Artifact {
    pub fn load(name: &'static str) -> Result<Self> {
        let document: Value =
            serde_json::from_str(include_str!("../../artifacts/GenesisChildFactory.json"))?;
        ensure!(
            document["compiler"] == "0.8.26+commit.8a97fa7a.Emscripten.clang"
                && document["settings"]["evmVersion"] == "shanghai",
            "Unexpected embedded compiler settings"
        );
        let value = &document["contracts"][name];
        ensure!(value["contractName"] == name, "Unknown embedded contract");
        ensure!(
            matches!(name, "GenesisChildFactory" | "GenesisMintChild"),
            "Unsupported deployment artifact"
        );
        let source = include_str!("../../contracts/GenesisChildFactory.sol");
        ensure!(
            value["sourceSha256"] == format!("{:x}", Sha256::digest(source.as_bytes())),
            "Embedded artifact is stale; recompile Solidity"
        );
        let init = eth::bytes(&value["bytecode"])?;
        let runtime = eth::bytes(&value["deployedBytecode"])?;
        ensure!(
            !init.is_empty()
                && init.len() <= 49152
                && !runtime.is_empty()
                && runtime.len() <= 24576,
            "Invalid embedded bytecode length"
        );
        let mut references = BTreeMap::new();
        let mut occupied = BTreeSet::new();
        for (key, id) in value["immutableIds"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Missing named immutable IDs"))?
        {
            let id = id
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid immutable ID"))?;
            let mut offsets = Vec::new();
            for item in value["immutableReferences"][id]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Missing immutable offsets"))?
            {
                let start = usize::try_from(
                    item["start"]
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("Invalid immutable offset"))?,
                )?;
                ensure!(
                    item["length"] == 32
                        && start
                            .checked_add(32)
                            .is_some_and(|end| end <= runtime.len()),
                    "Invalid immutable range"
                );
                for (index, byte) in runtime.iter().enumerate().skip(start).take(32) {
                    ensure!(
                        *byte == 0 && occupied.insert(index),
                        "Overlapping or nonzero immutable placeholder"
                    );
                }
                offsets.push(start);
            }
            ensure!(!offsets.is_empty(), "Empty immutable offsets");
            references.insert(key.clone(), offsets);
        }
        let start_time_slot = value["storageLayout"]["storage"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["label"] == "startTime"))
            .and_then(|row| row["slot"].as_str())
            .map(str::to_owned);
        Ok(Self {
            name,
            init,
            runtime,
            references,
            start_time_slot,
        })
    }

    pub fn runtime(&self, values: &BTreeMap<&str, [u8; 32]>) -> Result<Vec<u8>> {
        ensure!(
            values.len() == self.references.len(),
            "Immutable value count mismatch"
        );
        let mut result = self.runtime.clone();
        for (name, offsets) in &self.references {
            let value = values
                .get(name.as_str())
                .ok_or_else(|| anyhow::anyhow!("Missing immutable value"))?;
            for start in offsets {
                result[*start..*start + 32].copy_from_slice(value);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_artifacts() -> Result<()> {
        for name in ["GenesisChildFactory", "GenesisMintChild"] {
            let a = Artifact::load(name)?;
            ensure!(!a.init.is_empty(), "Empty init code");
        }
        Ok(())
    }
}
