//! Narrow, free-mint-only SeaDrop boundary. API calldata never becomes a transaction
//! until its destination, method, collection, recipient and payment are checked.

use alloy_primitives::{Address, B256, Signature, U256};
use alloy_sol_types::{SolCall, SolStruct, eip712_domain, sol};
use thiserror::Error;

pub const MAX_CALLDATA_BYTES: usize = 4096;
const TRUSTED_ATTRIBUTION: [u8; 4] = [0x3d, 0x95, 0x8f, 0xe2];

sol! {
    #[derive(Debug, PartialEq, Eq)]
    struct MintParams {
        uint256 mintPrice;
        uint256 maxTotalMintableByWallet;
        uint256 startTime;
        uint256 endTime;
        uint256 dropStageIndex;
        uint256 maxTokenSupplyForStage;
        uint256 feeBps;
        bool restrictFeeRecipients;
    }

    struct SignedMint {
        address nftContract;
        address minter;
        address feeRecipient;
        MintParams mintParams;
        uint256 salt;
    }

    function mintSigned(address nftContract, address feeRecipient,
        address minterIfNotPayer, uint256 quantity, MintParams mintParams,
        uint256 salt, bytes signature) external payable;
    function mintPublic(address nftContract, address feeRecipient,
        address minterIfNotPayer, uint256 quantity) external payable;
}

/// Deliberately has no Debug or Serialize: calldata can contain an unused signature.
pub struct MintPayload {
    pub target: Address,
    pub data: Vec<u8>,
    pub value: U256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintKind {
    Signed,
    Public,
}

#[derive(Clone, Copy, Debug)]
pub struct ApprovedMint {
    pub nft: Address,
    pub sea_drop: Address,
    pub fee_recipient: Address,
    /// The immediate caller/minter, normally the prepared child contract.
    pub minter: Address,
    pub chain_id: u64,
}

/// Structural validation is not proof of eligibility. The caller must check the
/// recovered signer and limits against fresh on-chain state and simulate the call.
/// Deliberately has no Debug or Serialize.
pub struct ValidatedPayload {
    /// Canonical calldata, with a recognized attribution suffix removed.
    pub data: Vec<u8>,
    pub kind: MintKind,
    pub signer: Option<Address>,
    pub params: Option<MintParams>,
    pub digest: Option<B256>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PayloadError {
    #[error("invalid approved mint addresses or chain")]
    InvalidApproval,
    #[error("mint API returned an unapproved transaction target")]
    Target,
    #[error("only a free mint with zero transaction value is supported")]
    Payment,
    #[error("mint calldata is malformed, oversized or uses an unsupported method")]
    Calldata,
    #[error("mint calldata is noncanonical or has unrecognized trailing attribution")]
    Noncanonical,
    #[error("mint API returned an unapproved collection, fee recipient or minter")]
    Recipient,
    #[error("each prepared minter must mint exactly one NFT")]
    Quantity,
    #[error("signed mint parameters have invalid limits or time boundaries")]
    Parameters,
    #[error("mint signature must be a valid 65-byte low-s signature with v 27 or 28")]
    Signature,
}

fn check_approval(expected: &ApprovedMint) -> Result<(), PayloadError> {
    if expected.chain_id != 4663
        || [
            expected.nft,
            expected.sea_drop,
            expected.fee_recipient,
            expected.minter,
        ]
        .contains(&Address::ZERO)
    {
        return Err(PayloadError::InvalidApproval);
    }
    Ok(())
}

fn check_fields(
    nft: Address,
    fee: Address,
    minter: Address,
    quantity: U256,
    expected: &ApprovedMint,
) -> Result<(), PayloadError> {
    if nft != expected.nft
        || fee != expected.fee_recipient
        || (minter != Address::ZERO && minter != expected.minter)
    {
        return Err(PayloadError::Recipient);
    }
    if quantity != U256::from(1) {
        return Err(PayloadError::Quantity);
    }
    Ok(())
}

fn canonical_data(actual: &[u8], canonical: Vec<u8>) -> Result<Vec<u8>, PayloadError> {
    let suffix = actual
        .strip_prefix(canonical.as_slice())
        .ok_or(PayloadError::Noncanonical)?;
    if !suffix.is_empty() && suffix != TRUSTED_ATTRIBUTION {
        return Err(PayloadError::Noncanonical);
    }
    Ok(canonical)
}

pub fn validate(
    payload: &MintPayload,
    expected: &ApprovedMint,
) -> Result<ValidatedPayload, PayloadError> {
    check_approval(expected)?;
    if payload.target != expected.sea_drop {
        return Err(PayloadError::Target);
    }
    if payload.value != U256::ZERO {
        return Err(PayloadError::Payment);
    }
    if payload.data.len() > MAX_CALLDATA_BYTES || payload.data.len() < 4 {
        return Err(PayloadError::Calldata);
    }
    if payload.data.starts_with(&mintPublicCall::SELECTOR) {
        let call = mintPublicCall::abi_decode_validate(&payload.data)
            .map_err(|_| PayloadError::Calldata)?;
        check_fields(
            call.nftContract,
            call.feeRecipient,
            call.minterIfNotPayer,
            call.quantity,
            expected,
        )?;
        return Ok(ValidatedPayload {
            data: canonical_data(&payload.data, call.abi_encode())?,
            kind: MintKind::Public,
            signer: None,
            params: None,
            digest: None,
        });
    }
    if !payload.data.starts_with(&mintSignedCall::SELECTOR) {
        return Err(PayloadError::Calldata);
    }
    let call =
        mintSignedCall::abi_decode_validate(&payload.data).map_err(|_| PayloadError::Calldata)?;
    check_fields(
        call.nftContract,
        call.feeRecipient,
        call.minterIfNotPayer,
        call.quantity,
        expected,
    )?;
    let data = canonical_data(&payload.data, call.abi_encode())?;
    let params = &call.mintParams;
    if params.mintPrice != U256::ZERO {
        return Err(PayloadError::Payment);
    }
    if params.startTime > params.endTime
        || params.endTime == U256::ZERO
        || params.maxTotalMintableByWallet == U256::ZERO
        || params.maxTokenSupplyForStage == U256::ZERO
        || params.feeBps > U256::from(10_000)
        || !params.restrictFeeRecipients
    {
        return Err(PayloadError::Parameters);
    }
    if call.signature.len() != 65 || !matches!(call.signature.last(), Some(27 | 28)) {
        return Err(PayloadError::Signature);
    }
    let signature = Signature::from_raw(&call.signature).map_err(|_| PayloadError::Signature)?;
    if signature.normalize_s().is_some() {
        return Err(PayloadError::Signature);
    }
    let signed = SignedMint {
        nftContract: call.nftContract,
        minter: expected.minter,
        feeRecipient: call.feeRecipient,
        mintParams: call.mintParams.clone(),
        salt: call.salt,
    };
    let domain = eip712_domain! {
        name: "SeaDrop",
        version: "1.0",
        chain_id: expected.chain_id,
        verifying_contract: expected.sea_drop,
    };
    let digest = signed.eip712_signing_hash(&domain);
    let signer = signature
        .recover_address_from_prehash(&digest)
        .map_err(|_| PayloadError::Signature)?;
    Ok(ValidatedPayload {
        data,
        kind: MintKind::Signed,
        signer: Some(signer),
        params: Some(call.mintParams),
        digest: Some(digest),
    })
}

/// Public-stage eligibility and current price still require a live on-chain check.
pub fn build_public(expected: &ApprovedMint) -> Result<MintPayload, PayloadError> {
    check_approval(expected)?;
    Ok(MintPayload {
        target: expected.sea_drop,
        data: mintPublicCall {
            nftContract: expected.nft,
            feeRecipient: expected.fee_recipient,
            minterIfNotPayer: Address::ZERO,
            quantity: U256::from(1),
        }
        .abi_encode(),
        value: U256::ZERO,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, hex};

    fn reference() -> (MintPayload, ApprovedMint) {
        // Historical, already used signature from the public reference transaction.
        let json: serde_json::Value =
            serde_json::from_str(include_str!("../../research/reference-transaction.json"))
                .unwrap();
        (
            MintPayload {
                target: json["to"].as_str().unwrap().parse().unwrap(),
                data: hex::decode(json["data"].as_str().unwrap()).unwrap(),
                value: U256::ZERO,
            },
            ApprovedMint {
                nft: address!("116eaa62241751e0c98da43d458600c6c17cd361"),
                sea_drop: address!("00005ea00ac477b1030ce78506496e8c2de24bf5"),
                fee_recipient: address!("0000a26b00c1f0df003000390027140000faa719"),
                minter: json["from"].as_str().unwrap().parse().unwrap(),
                chain_id: 4663,
            },
        )
    }

    #[test]
    fn historical_digest_and_recovered_signer_match_independent_ethers_fixture() {
        let (payload, expected) = reference();
        let valid = validate(&payload, &expected).unwrap();
        assert_eq!(valid.kind, MintKind::Signed);
        assert_eq!(
            valid.digest,
            Some(b256!(
                "177d80653c546eca6a79df4b868a40fbb6b5815d6c16241a44c7993c00845e77"
            ))
        );
        assert_eq!(
            valid.signer,
            Some(address!("fce4b31128100915f2980bbc3a08894ee5e8f8c3"))
        );
        assert_eq!(valid.data.len(), 580);
        assert_eq!(
            valid.params.as_ref().unwrap().maxTokenSupplyForStage,
            U256::from(1024)
        );
    }

    #[test]
    fn implicit_minter_is_cryptographically_bound_and_needs_live_signer_authorization() {
        let (payload, mut expected) = reference();
        let original = validate(&payload, &expected).unwrap();
        expected.minter = Address::repeat_byte(0x77);
        let foreign = validate(&payload, &expected).unwrap();
        assert_ne!(original.digest, foreign.digest);
        assert_ne!(original.signer, foreign.signer);
        expected.chain_id = 1;
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::InvalidApproval)
        ));
    }

    #[test]
    fn changed_targets_payment_quantity_and_explicit_minter_are_rejected() {
        let (mut payload, expected) = reference();
        payload.target = Address::repeat_byte(1);
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Target)
        ));
        payload.target = expected.sea_drop;
        payload.value = U256::from(1);
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Payment)
        ));
        payload.value = U256::ZERO;
        let original = mintSignedCall::abi_decode(&payload.data).unwrap();
        let mut call = original.clone();
        call.nftContract = Address::repeat_byte(1);
        payload.data = call.abi_encode();
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Recipient)
        ));
        call = original.clone();
        call.feeRecipient = Address::repeat_byte(1);
        payload.data = call.abi_encode();
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Recipient)
        ));
        call = original.clone();
        call.minterIfNotPayer = Address::repeat_byte(1);
        payload.data = call.abi_encode();
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Recipient)
        ));
        call = original;
        call.quantity = U256::from(2);
        payload.data = call.abi_encode();
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Quantity)
        ));
    }

    #[test]
    fn noncanonical_unknown_trailing_and_malformed_data_are_rejected() {
        let (mut payload, expected) = reference();
        payload.data.pop();
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Noncanonical)
        ));
        payload.data.truncate(579);
        assert!(validate(&payload, &expected).is_err());
        payload.data = vec![0; MAX_CALLDATA_BYTES + 1];
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Calldata)
        ));
        payload.data = vec![0, 0, 0, 0];
        assert!(matches!(
            validate(&payload, &expected),
            Err(PayloadError::Calldata)
        ));
    }

    #[test]
    fn high_s_bad_v_truncated_and_zero_signatures_are_rejected() {
        let (mut payload, expected) = reference();
        let original = mintSignedCall::abi_decode(&payload.data).unwrap();
        for signature in [
            vec![0; 65],
            vec![0; 64],
            {
                let mut data = original.signature.to_vec();
                data[64] = 1;
                data
            },
            {
                let mut data = original.signature.to_vec();
                data[32..64].fill(0xff);
                data
            },
        ] {
            let mut call = original.clone();
            call.signature = signature.into();
            payload.data = call.abi_encode();
            assert!(matches!(
                validate(&payload, &expected),
                Err(PayloadError::Signature)
            ));
        }
    }

    #[test]
    fn signed_parameter_bounds_are_checked_before_signer_recovery() {
        let (mut payload, expected) = reference();
        let original = mintSignedCall::abi_decode(&payload.data).unwrap();
        for case in 0..6 {
            let mut call = original.clone();
            match case {
                0 => call.mintParams.mintPrice = U256::from(1),
                1 => call.mintParams.startTime = call.mintParams.endTime + U256::from(1),
                2 => call.mintParams.maxTotalMintableByWallet = U256::ZERO,
                3 => call.mintParams.maxTokenSupplyForStage = U256::ZERO,
                4 => call.mintParams.feeBps = U256::from(10_001),
                5 => call.mintParams.restrictFeeRecipients = false,
                _ => unreachable!(),
            }
            payload.data = call.abi_encode();
            assert!(matches!(
                validate(&payload, &expected),
                Err(PayloadError::Payment | PayloadError::Parameters)
            ));
        }
    }

    #[test]
    fn noncanonical_dynamic_offset_is_rejected() {
        let (mut payload, expected) = reference();
        payload.data.truncate(580);
        // Same decoded arguments, but a gap before the dynamic signature tail.
        payload.data.splice(452..452, [0; 32]);
        payload.data[420..452].copy_from_slice(&U256::from(480).to_be_bytes::<32>());
        assert!(validate(&payload, &expected).is_err());
    }

    #[test]
    fn public_builder_has_one_nft_and_no_server_signature() {
        let (_, expected) = reference();
        let payload = build_public(&expected).unwrap();
        let valid = validate(&payload, &expected).unwrap();
        assert_eq!(valid.kind, MintKind::Public);
        assert!(valid.signer.is_none() && valid.params.is_none() && valid.digest.is_none());
        assert_eq!(valid.data.len(), 132);
    }
}
