use alloy_primitives::{Address, B256, keccak256};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::eth;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub number: u64,
    pub timestamp: u64,
    pub hash: B256,
    pub parent_hash: B256,
}

impl Header {
    pub fn parse(value: &Value) -> Result<Self> {
        Ok(Self {
            number: eth::quantity64(&value["number"])?,
            timestamp: eth::quantity64(&value["timestamp"])?,
            hash: eth::hash(&value["hash"])?,
            parent_hash: eth::hash(&value["parentHash"])?,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub hash: B256,
    pub block_hash: B256,
    pub block_number: u64,
    pub transaction_index: u64,
    pub success: bool,
    pub gas_used: u64,
    pub effective_gas_price_wei: String,
    pub gas_cost_wei: String,
    pub contract_address: Option<Address>,
    #[serde(skip)]
    pub logs: Vec<Value>,
}

impl Receipt {
    pub fn parse(value: &Value, expected: B256) -> Result<Self> {
        let hash = eth::hash(&value["transactionHash"])?;
        ensure!(hash == expected, "Receipt transaction hash mismatch");
        let status = eth::quantity64(&value["status"])?;
        ensure!(status <= 1, "Invalid transaction status");
        let gas_used = eth::quantity64(&value["gasUsed"])?;
        let price = eth::quantity(&value["effectiveGasPrice"])?;
        let cost = price
            .checked_mul(u128::from(gas_used))
            .ok_or_else(|| anyhow::anyhow!("Gas cost overflow"))?;
        let contract_address = if value["contractAddress"].is_null() {
            None
        } else {
            Some(
                value["contractAddress"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Invalid created address"))?
                    .parse()?,
            )
        };
        let logs = value["logs"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Receipt missing logs"))?;
        ensure!(logs.len() <= 1000, "Excessive receipt logs");
        Ok(Self {
            hash,
            block_hash: eth::hash(&value["blockHash"])?,
            block_number: eth::quantity64(&value["blockNumber"])?,
            transaction_index: eth::quantity64(&value["transactionIndex"])?,
            success: status == 1,
            gas_used,
            effective_gas_price_wei: price.to_string(),
            gas_cost_wei: cost.to_string(),
            contract_address,
            logs: logs.clone(),
        })
    }

    pub fn cost(&self) -> Result<u128> {
        Ok(self.gas_cost_wei.parse()?)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub status: u8,
    pub status_name: &'static str,
    pub requested: u64,
    pub minted: u64,
    pub remaining: u64,
    pub first_token_id: u64,
    /// One distinct minting helper per token, ordered by ascending token ID.
    pub helpers: Vec<Address>,
}

fn log_address(value: &Value) -> Result<Address> {
    value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Log address is not a string"))?
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid log address"))
}

fn indexed_address(value: &Value) -> Result<Address> {
    let word = eth::bytes(value)?;
    ensure!(
        word.len() == 32 && word[..12].iter().all(|byte| *byte == 0),
        "Noncanonical indexed address"
    );
    Ok(Address::from_slice(&word[12..]))
}

fn log_topics(log: &Value) -> Result<&Vec<Value>> {
    let topics = log["topics"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Log topics are not an array"))?;
    ensure!(topics.len() <= 4, "Too many log topics");
    for topic in topics {
        eth::hash(topic)?;
    }
    ensure!(
        log.get("removed")
            .is_none_or(|value| value == &Value::Bool(false)),
        "Removed or malformed log"
    );
    Ok(topics)
}

pub fn batch_result(
    receipt: &Receipt,
    factory: Address,
    collection: Address,
    recipient: Address,
    round: u64,
    quantity: u64,
) -> Result<BatchResult> {
    ensure!(receipt.success, "Mint transaction reverted");
    ensure!(
        round < 10 && (1..=10).contains(&quantity) && receipt.logs.len() <= 1000,
        "Invalid benchmark bounds"
    );
    ensure!(
        factory != Address::ZERO
            && collection != Address::ZERO
            && recipient != Address::ZERO
            && factory != collection,
        "Invalid benchmark addresses"
    );
    let signature = keccak256(b"BatchResult(uint256,uint8,uint256,uint256,uint256,uint256)");
    let mut matching = Vec::new();
    for (index, log) in receipt.logs.iter().enumerate() {
        let address = log_address(&log["address"])?;
        if address == factory || address == collection {
            let topics = log_topics(log)?;
            if address == factory && topics.first().map(eth::hash).transpose()? == Some(signature) {
                matching.push((index, log));
            }
        }
    }
    ensure!(
        matching.len() == 1,
        "Expected exactly one factory result event"
    );
    let (result_index, log) = matching[0];
    ensure!(
        log["topics"].as_array().is_some_and(|a| a.len() == 2),
        "Invalid result event topics"
    );
    ensure!(
        eth::decode_word(&eth::bytes(&log["topics"][1])?)? == u128::from(round),
        "Round event mismatch"
    );
    let data = eth::bytes(&log["data"])?;
    ensure!(data.len() == 160, "Invalid result event data");
    let values = data
        .chunks_exact(32)
        .map(eth::decode_word)
        .collect::<Result<Vec<_>>>()?;
    let status = u8::try_from(values[0])?;
    let names = [
        "minted",
        "partial",
        "sold_out",
        "not_armed",
        "too_early",
        "expired",
        "already_attempted",
    ];
    let status_name = *names
        .get(usize::from(status))
        .ok_or_else(|| anyhow::anyhow!("Unknown mint result status"))?;
    let mut result = BatchResult {
        status,
        status_name,
        requested: u64::try_from(values[1])?,
        minted: u64::try_from(values[2])?,
        remaining: u64::try_from(values[3])?,
        first_token_id: u64::try_from(values[4])?,
        helpers: Vec::new(),
    };
    ensure!(
        result.requested == quantity && result.minted <= quantity && result.remaining <= 10000,
        "Invalid mint result amounts"
    );
    ensure!(
        match status {
            0 => result.minted == quantity,
            1 => result.minted > 0 && result.minted < quantity && result.remaining == 0,
            2 => result.minted == 0 && result.remaining == 0,
            3 => result.minted == 0 && result.remaining == 10000,
            _ => result.minted == 0,
        },
        "Mint status, amount and remaining supply disagree"
    );
    let end = result
        .first_token_id
        .checked_add(result.minted)
        .ok_or_else(|| anyhow::anyhow!("Token range overflow"))?;
    if result.minted > 0 {
        ensure!(
            result.first_token_id > 0
                && end - 1 <= 10000
                && (end - 1).checked_add(result.remaining) == Some(10000),
            "Token range and remaining supply disagree"
        );
    } else {
        ensure!(
            result.first_token_id == 0,
            "Non-mint status has a first token ID"
        );
    }
    let transfer = keccak256(b"Transfer(address,address,uint256)");
    let mut paths = vec![(None::<Address>, false); usize::try_from(result.minted)?];
    let mut helpers = HashSet::with_capacity(paths.len());
    for (index, log) in receipt.logs.iter().enumerate() {
        if log_address(&log["address"])? != collection {
            continue;
        }
        let topics = log_topics(log)?;
        if topics.first().map(eth::hash).transpose()? != Some(transfer) {
            continue;
        }
        ensure!(
            index < result_index,
            "Transfer appears after the final batch event"
        );
        ensure!(
            topics.len() == 4 && eth::bytes(&log["data"])?.is_empty(),
            "Invalid ERC721 Transfer encoding"
        );
        let from = indexed_address(&topics[1])?;
        let to = indexed_address(&topics[2])?;
        let token_id = u64::try_from(eth::decode_word(&eth::bytes(&topics[3])?)?)?;
        ensure!(
            token_id >= result.first_token_id && token_id < end,
            "Transfer token ID outside the declared mint range"
        );
        let path = paths
            .get_mut(usize::try_from(token_id - result.first_token_id)?)
            .ok_or_else(|| anyhow::anyhow!("Invalid transfer token index"))?;
        if from == Address::ZERO {
            ensure!(
                path.0.is_none() && !path.1,
                "Duplicate mint Transfer for token"
            );
            ensure!(
                to != Address::ZERO && to != recipient && to != factory && to != collection,
                "Invalid mint helper"
            );
            ensure!(helpers.insert(to), "Mint helper reused for multiple tokens");
            path.0 = Some(to);
        } else {
            ensure!(
                path.0 == Some(from) && to == recipient && !path.1,
                "Transfer does not complete the unique helper-to-recipient path"
            );
            path.1 = true;
        }
    }
    for (helper, delivered) in paths {
        ensure!(delivered, "Minted token was not transferred to recipient");
        result
            .helpers
            .push(helper.ok_or_else(|| anyhow::anyhow!("Missing helper mint event"))?);
    }
    Ok(result)
}

pub fn first_block_proof(previous: &Header, first: &Header, target: u64) -> Result<()> {
    ensure!(
        first.number
            == previous
                .number
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Block overflow"))?
            && first.parent_hash == previous.hash
            && previous.timestamp < target
            && first.timestamp >= target,
        "Invalid first-block boundary proof"
    );
    Ok(())
}

pub fn percentile(values: &[f64], numerator: usize, denominator: usize) -> Option<f64> {
    if values.is_empty() || denominator == 0 || numerator == 0 || numerator > denominator {
        return None;
    }
    let mut values = values.to_vec();
    if values.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return None;
    }
    values.sort_by(f64::total_cmp);
    values
        .get((values.len() * numerator).div_ceil(denominator) - 1)
        .copied()
}

pub fn latency_summary(values: &[f64]) -> Value {
    json!({"count":values.len(),"p50Ms":percentile(values,1,2),"p95Ms":percentile(values,95,100),
        "p99Ms":percentile(values,99,100),"note":"At N=10, nearest-rank p95 and p99 equal the maximum; not a stable tail estimate."})
}

#[cfg(test)]
mod tests {
    use super::*;
    const FACTORY: Address = Address::repeat_byte(0xf1);
    const COLLECTION: Address = Address::repeat_byte(0xf2);
    const RECIPIENT: Address = Address::repeat_byte(0xf3);

    fn transfer(from: Address, to: Address, token_id: u64) -> Value {
        json!({"address":COLLECTION,"topics":[keccak256(b"Transfer(address,address,uint256)"),
            eth::hex(&eth::address_word(from)),eth::hex(&eth::address_word(to)),eth::hex(&eth::word(u128::from(token_id)))],"data":"0x"})
    }

    fn batch_receipt(
        status: u8,
        requested: u64,
        minted: u64,
        remaining: u64,
        first: u64,
    ) -> Receipt {
        let mut logs = Vec::new();
        for index in 0..minted {
            let helper = Address::repeat_byte(0x30 + index as u8);
            logs.push(transfer(Address::ZERO, helper, first + index));
            logs.push(transfer(helper, RECIPIENT, first + index));
        }
        let values = [
            u128::from(status),
            u128::from(requested),
            u128::from(minted),
            u128::from(remaining),
            u128::from(first),
        ];
        let data: Vec<u8> = values.into_iter().flat_map(eth::word).collect();
        logs.push(json!({"address":FACTORY,"topics":[keccak256(b"BatchResult(uint256,uint8,uint256,uint256,uint256,uint256)"),
            eth::hex(&eth::word(3))],"data":eth::hex(&data)}));
        Receipt {
            hash: B256::repeat_byte(1),
            block_hash: B256::repeat_byte(2),
            block_number: 100,
            transaction_index: 0,
            success: true,
            gas_used: 100000,
            effective_gas_price_wei: "1".to_owned(),
            gas_cost_wei: "100000".to_owned(),
            contract_address: None,
            logs,
        }
    }

    fn verify(receipt: &Receipt, requested: u64) -> Result<BatchResult> {
        batch_result(receipt, FACTORY, COLLECTION, RECIPIENT, 3, requested)
    }

    fn token_id(log: &mut Value, id: u64) {
        log["topics"][3] = json!(eth::hex(&eth::word(u128::from(id))));
    }

    fn result_field(receipt: &mut Receipt, index: usize, value: u128) {
        let event = receipt.logs.last_mut().unwrap();
        let mut data = eth::bytes(&event["data"]).unwrap();
        data[index * 32..(index + 1) * 32].copy_from_slice(&eth::word(value));
        event["data"] = json!(eth::hex(&data));
    }

    #[test]
    fn batch_validates_complete_paths_and_returns_helpers_in_token_order() {
        let result = verify(&batch_receipt(0, 2, 2, 9898, 101), 2).unwrap();
        assert_eq!(result.minted, 2);
        assert_eq!(result.first_token_id, 101);
        assert_eq!(
            result.helpers,
            vec![Address::repeat_byte(0x30), Address::repeat_byte(0x31)]
        );
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["statusName"], "minted");
        assert_eq!(json["firstTokenId"], 101);
        assert_eq!(json["helpers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn partial_and_zero_mint_outcomes_have_consistent_supply() {
        let partial = verify(&batch_receipt(1, 3, 2, 0, 9999), 3).unwrap();
        assert_eq!(partial.status_name, "partial");
        assert_eq!(partial.helpers.len(), 2);
        for (status, remaining) in [(2, 0), (3, 10000), (4, 9999), (5, 0), (6, 100)] {
            let result = verify(&batch_receipt(status, 2, 0, remaining, 0), 2).unwrap();
            assert_eq!(result.minted, 0);
            assert!(result.helpers.is_empty());
        }
    }

    #[test]
    fn equal_transfer_counts_cannot_hide_duplicate_or_out_of_range_tokens() {
        for replacement in [101, 103] {
            let mut receipt = batch_receipt(0, 2, 2, 9898, 101);
            token_id(&mut receipt.logs[2], replacement);
            token_id(&mut receipt.logs[3], replacement);
            // Still two mint events and two recipient transfers, but not the
            // declared set {101,102}. Count-only validation would accept this.
            assert!(verify(&receipt, 2).is_err());
        }
    }

    #[test]
    fn direct_mint_is_not_a_helper_mint_even_when_both_old_counts_match() {
        let mut receipt = batch_receipt(0, 1, 1, 9993, 7);
        receipt.logs[0] = transfer(Address::ZERO, RECIPIENT, 7);
        receipt.logs.remove(1);
        // One mint and one receipt by the recipient, with no helper at all.
        assert!(verify(&receipt, 1).is_err());
    }

    #[test]
    fn helper_paths_reject_wrong_sender_reuse_and_wrong_recipient() {
        let mut wrong_sender = batch_receipt(0, 2, 2, 9898, 101);
        wrong_sender.logs[1]["topics"][1] =
            json!(eth::hex(&eth::address_word(Address::repeat_byte(0x55))));
        assert!(verify(&wrong_sender, 2).is_err());

        let mut reused = batch_receipt(0, 2, 2, 9898, 101);
        reused.logs[2] = transfer(Address::ZERO, Address::repeat_byte(0x30), 102);
        reused.logs[3] = transfer(Address::repeat_byte(0x30), RECIPIENT, 102);
        assert!(verify(&reused, 2).is_err());

        let mut wrong_recipient = batch_receipt(0, 2, 2, 9898, 101);
        wrong_recipient.logs[1]["topics"][2] =
            json!(eth::hex(&eth::address_word(Address::repeat_byte(0x55))));
        assert!(verify(&wrong_recipient, 2).is_err());

        for helper in [Address::ZERO, FACTORY, COLLECTION] {
            let mut invalid_helper = batch_receipt(0, 1, 1, 9993, 7);
            invalid_helper.logs[0] = transfer(Address::ZERO, helper, 7);
            invalid_helper.logs[1] = transfer(helper, RECIPIENT, 7);
            assert!(verify(&invalid_helper, 1).is_err());
        }
    }

    #[test]
    fn every_token_requires_one_ordered_delivery_before_batch_result() {
        let original = batch_receipt(0, 2, 2, 9898, 101);
        let mut missing = original.clone();
        missing.logs.remove(1);
        assert!(verify(&missing, 2).is_err());
        let mut duplicate = original.clone();
        duplicate.logs.insert(2, duplicate.logs[1].clone());
        assert!(verify(&duplicate, 2).is_err());
        let mut reversed = original.clone();
        reversed.logs.swap(0, 1);
        assert!(verify(&reversed, 2).is_err());
        let mut early_result = original;
        early_result.logs.rotate_right(1);
        assert!(verify(&early_result, 2).is_err());
    }

    #[test]
    fn event_words_topics_data_and_removed_flag_must_be_canonical() {
        let original = batch_receipt(0, 2, 2, 9898, 101);
        let mut padding = original.clone();
        let mut address_word = eth::address_word(Address::repeat_byte(0x30));
        address_word[0] = 1;
        padding.logs[0]["topics"][2] = json!(eth::hex(&address_word));
        assert!(verify(&padding, 2).is_err());
        let mut short_topic = original.clone();
        short_topic.logs[0]["topics"][3] = json!("0x01");
        assert!(verify(&short_topic, 2).is_err());
        let mut oversized_id = original.clone();
        oversized_id.logs[0]["topics"][3] = json!(eth::hex(&eth::word(u128::from(u64::MAX) + 1)));
        assert!(verify(&oversized_id, 2).is_err());
        let mut data = original.clone();
        data.logs[0]["data"] = json!("0x00");
        assert!(verify(&data, 2).is_err());
        let mut topics = original.clone();
        topics.logs[0]["topics"]
            .as_array_mut()
            .unwrap()
            .push(json!(B256::ZERO));
        assert!(verify(&topics, 2).is_err());
        let mut removed = original.clone();
        removed.logs[0]["removed"] = json!(true);
        assert!(verify(&removed, 2).is_err());
        let mut duplicate_result = original.clone();
        duplicate_result
            .logs
            .push(duplicate_result.logs.last().unwrap().clone());
        assert!(verify(&duplicate_result, 2).is_err());
        let mut wrong_round = original;
        wrong_round.logs.last_mut().unwrap()["topics"][1] = json!(eth::hex(&eth::word(4)));
        assert!(verify(&wrong_round, 2).is_err());
    }

    #[test]
    fn inconsistent_status_supply_and_integer_ranges_are_rejected() {
        let mut partial_remaining = batch_receipt(1, 3, 2, 0, 9999);
        result_field(&mut partial_remaining, 3, 1);
        assert!(verify(&partial_remaining, 3).is_err());
        let mut sold_out_remaining = batch_receipt(2, 2, 0, 0, 0);
        result_field(&mut sold_out_remaining, 3, 1);
        assert!(verify(&sold_out_remaining, 2).is_err());
        let mut no_mint_first = batch_receipt(5, 2, 0, 10000, 0);
        result_field(&mut no_mint_first, 4, 1);
        assert!(verify(&no_mint_first, 2).is_err());
        for (field, value) in [
            (0, 7),
            (1, 0),
            (2, 3),
            (3, 9999),
            (4, 0),
            (4, u128::from(u64::MAX)),
            (2, u128::MAX),
        ] {
            let mut invalid = batch_receipt(0, 2, 2, 9898, 101);
            result_field(&mut invalid, field, value);
            assert!(verify(&invalid, 2).is_err(), "field {field}, value {value}");
        }
    }

    #[test]
    fn unrelated_collection_events_cannot_supply_a_missing_expected_path() {
        let mut missing = batch_receipt(0, 2, 2, 9898, 101);
        missing.logs[1]["address"] = json!(Address::repeat_byte(0xee));
        assert!(verify(&missing, 2).is_err());

        let mut valid = batch_receipt(0, 2, 2, 9898, 101);
        let mut unrelated = transfer(Address::ZERO, RECIPIENT, 999);
        unrelated["address"] = json!(Address::repeat_byte(0xee));
        valid.logs.push(unrelated);
        assert!(verify(&valid, 2).is_ok());
    }
    #[test]
    fn boundary_needs_adjacent_canonical_blocks() -> Result<()> {
        let previous = Header {
            number: 9,
            timestamp: 99,
            hash: B256::repeat_byte(1),
            parent_hash: B256::ZERO,
        };
        let first = Header {
            number: 10,
            timestamp: 100,
            hash: B256::repeat_byte(2),
            parent_hash: previous.hash,
        };
        first_block_proof(&previous, &first, 100)?;
        assert!(first_block_proof(&previous, &first, 99).is_err());
        let gap = Header {
            number: 11,
            ..first
        };
        assert!(first_block_proof(&previous, &gap, 100).is_err());
        Ok(())
    }
    #[test]
    fn ten_samples_cannot_estimate_a_tail() {
        let v = (1..=10).map(f64::from).collect::<Vec<_>>();
        assert_eq!(percentile(&v, 1, 2), Some(5.0));
        assert_eq!(percentile(&v, 95, 100), Some(10.0));
        assert_eq!(percentile(&v, 99, 100), Some(10.0));
        assert_eq!(percentile(&[f64::NAN], 1, 2), None);
    }
}
