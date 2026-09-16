//! Local EIP-1559 signing using Alloy's canonical signing and envelope codecs.
//! No endpoint access, wallet files, funds, or broadcasting belongs here.

use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{Address, B256, Bytes, TxKind, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;

#[derive(Debug, thiserror::Error)]
pub enum SignError {
    #[error("INVALID_PRIVATE_KEY")]
    InvalidKey,
    #[error("INVALID_TRANSACTION_FIELDS")]
    InvalidTransaction,
    #[error("SIGNING_FAILED")]
    Signing,
}

/// Deliberately has no `Debug`: callers must never log a signer or private key.
pub struct Signer(PrivateKeySigner);

pub struct TxRequest {
    pub chain_id: u64,
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub to: Option<Address>,
    pub input: Vec<u8>,
}

/// Signed transaction bytes are intentionally excluded from `Debug`/Serialize.
/// Only `hash` should enter benchmark reports. Value is always zero.
pub struct SignedTx {
    pub raw: String,
    pub hash: B256,
}

impl Signer {
    /// The caller owns and promptly zeroizes its input buffer. The underlying
    /// k256 SigningKey zeroizes its secret scalar when the signer is dropped.
    pub fn from_key(key: &str) -> Result<Self, SignError> {
        key.parse::<PrivateKeySigner>()
            .map(Self)
            .map_err(|_| SignError::InvalidKey)
    }

    pub fn address(&self) -> Address {
        self.0.address()
    }

    pub fn sign(&self, request: &TxRequest) -> Result<SignedTx, SignError> {
        if request.chain_id == 0
            || request.gas_limit < 21_000
            || request.max_priority_fee_per_gas > request.max_fee_per_gas
            || request.input.len() > 256 * 1024
        {
            return Err(SignError::InvalidTransaction);
        }
        let tx = TxEip1559 {
            chain_id: request.chain_id,
            nonce: request.nonce,
            gas_limit: request.gas_limit,
            max_fee_per_gas: request.max_fee_per_gas,
            max_priority_fee_per_gas: request.max_priority_fee_per_gas,
            to: request.to.map_or(TxKind::Create, TxKind::Call),
            value: U256::ZERO,
            access_list: Default::default(),
            input: Bytes::copy_from_slice(&request.input),
        };
        let signature = self
            .0
            .sign_hash_sync(&tx.signature_hash())
            .map_err(|_| SignError::Signing)?;
        let envelope: TxEnvelope = tx.into_signed(signature).into();
        Ok(SignedTx {
            raw: alloy_primitives::hex::encode_prefixed(envelope.encoded_2718()),
            hash: *envelope.tx_hash(),
        })
    }
}

pub fn predict_create(sender: Address, nonce: u64) -> Address {
    sender.create(nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_consensus::{Transaction, transaction::SignerRecoverable};
    use alloy_eips::eip2718::Decodable2718;

    // Synthetic public test scalar, never a funded account or user secret.
    const TEST_KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    fn request() -> TxRequest {
        TxRequest {
            chain_id: 31_337,
            nonce: 7,
            gas_limit: 150_000,
            max_fee_per_gas: 20_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
            to: None,
            input: vec![0x60, 0x00, 0x60, 0x00, 0xf3],
        }
    }

    #[test]
    fn signed_creation_roundtrip_recovers_owner_and_all_fields() {
        let signer = Signer::from_key(TEST_KEY).unwrap();
        let request = request();
        let signed = signer.sign(&request).unwrap();
        let bytes = alloy_primitives::hex::decode(signed.raw).unwrap();
        assert_eq!(bytes[0], 2);
        let envelope = TxEnvelope::decode_2718_exact(&bytes).unwrap();
        assert_eq!(envelope.recover_signer().unwrap(), signer.address());
        assert_eq!(*envelope.tx_hash(), signed.hash);
        assert_eq!(envelope.chain_id(), Some(request.chain_id));
        assert_eq!(envelope.nonce(), request.nonce);
        assert_eq!(envelope.gas_limit(), request.gas_limit);
        assert_eq!(envelope.max_fee_per_gas(), request.max_fee_per_gas);
        assert_eq!(
            envelope.max_priority_fee_per_gas(),
            Some(request.max_priority_fee_per_gas)
        );
        assert!(envelope.is_create());
        assert_eq!(envelope.value(), U256::ZERO);
        assert_eq!(envelope.input().as_ref(), request.input);
    }

    #[test]
    fn call_transaction_binds_recipient_and_chain() {
        let signer = Signer::from_key(TEST_KEY).unwrap();
        let mut request = request();
        request.to = Some(Address::repeat_byte(0x12));
        let original = signer.sign(&request).unwrap();
        let envelope =
            TxEnvelope::decode_2718_exact(&alloy_primitives::hex::decode(&original.raw).unwrap())
                .unwrap();
        assert_eq!(envelope.to(), request.to);
        assert_eq!(envelope.value(), U256::ZERO);
        request.chain_id += 1;
        assert_ne!(original.hash, signer.sign(&request).unwrap().hash);
    }

    #[test]
    fn invalid_keys_and_fee_fields_are_redacted() {
        let secret_text = "synthetic-invalid-secret-do-not-print";
        assert_eq!(
            Signer::from_key(secret_text).err().unwrap().to_string(),
            "INVALID_PRIVATE_KEY"
        );
        let signer = Signer::from_key(TEST_KEY).unwrap();
        let mut request = request();
        request.max_priority_fee_per_gas = request.max_fee_per_gas + 1;
        assert!(matches!(
            signer.sign(&request),
            Err(SignError::InvalidTransaction)
        ));
        request.max_priority_fee_per_gas = 0;
        request.chain_id = 0;
        assert!(matches!(
            signer.sign(&request),
            Err(SignError::InvalidTransaction)
        ));
    }

    #[test]
    fn create_address_matches_known_zero_sender_nonce_zero_vector() {
        let expected: Address = "0xbd770416a3345f91e4b34576cb804a576fa48eb1"
            .parse()
            .unwrap();
        assert_eq!(predict_create(Address::ZERO, 0), expected);
        assert_ne!(predict_create(Address::ZERO, 1), expected);
    }
}
