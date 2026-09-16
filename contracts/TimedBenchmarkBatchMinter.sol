// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimedBenchmarkNFT} from "./TimedBenchmarkNFT.sol";

/// @dev Constructor-only helper: mint one NFT and transfer it to the fixed recipient.
///      No arbitrary calls, approvals, payable methods, or subsequent mint entry point.
contract TimedBenchmarkMintHelper {
    uint256 public immutable tokenId;

    error UnexpectedOwnership();

    constructor(TimedBenchmarkNFT collection, address recipient, uint256 round) {
        uint256 id = collection.mint(round);
        if (collection.ownerOf(id) != address(this)) revert UnexpectedOwnership();
        collection.transferFrom(address(this), recipient, id);
        if (collection.ownerOf(id) != recipient) revert UnexpectedOwnership();
        tokenId = id;
    }
}

/// @notice Bounded mint benchmark for the caller's own TimedBenchmarkNFT.
/// @dev Supply is read before CREATE. Transactions execute atomically: competing
///      transactions cannot interleave between the check and the helper mints.
///      Normal timing/supply outcomes return a status; unexpected dependency failures revert.
contract TimedBenchmarkBatchMinter {
    enum Status { Minted, Partial, SoldOut, NotArmed, TooEarly, Expired, AlreadyAttempted }

    address public immutable owner;
    TimedBenchmarkNFT public immutable collection;
    address public immutable recipient;
    mapping(uint256 => bool) public attemptedRounds;
    bool private _entered;

    error NotOwner();
    error InvalidCollection();
    error InvalidRecipient();
    error InvalidRound();
    error InvalidQuantity();
    error ReentrantCall();
    error UnexpectedTokenSequence();

    event BatchResult(uint256 indexed round, uint8 status, uint256 requested, uint256 minted,
        uint256 remaining, uint256 firstTokenId);

    constructor(address collectionAddress, address recipientAddress) {
        if (recipientAddress == address(0)) revert InvalidRecipient();
        if (collectionAddress.code.length == 0) revert InvalidCollection();
        TimedBenchmarkNFT target = TimedBenchmarkNFT(collectionAddress);
        if (target.owner() != msg.sender || target.MAX_SUPPLY() != 10_000 || target.ROUNDS() != 10) {
            revert InvalidCollection();
        }
        owner = msg.sender;
        collection = target;
        recipient = recipientAddress;
    }

    modifier guarded() {
        if (msg.sender != owner) revert NotOwner();
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    function mintBatch(uint256 round, uint256 maxCount) external guarded returns (uint256 minted, uint8 status) {
        if (round >= 10) revert InvalidRound();
        if (maxCount == 0 || maxCount > 10) revert InvalidQuantity();
        uint256 remaining = collection.remainingSupply();
        uint256 start = collection.startTime();
        if (start == 0) return _result(round, Status.NotArmed, maxCount, 0, remaining, 0);
        uint256 opens = start + round;
        if (block.timestamp < opens) return _result(round, Status.TooEarly, maxCount, 0, remaining, 0);
        if (block.timestamp >= opens + 1) return _result(round, Status.Expired, maxCount, 0, remaining, 0);
        if (attemptedRounds[round]) return _result(round, Status.AlreadyAttempted, maxCount, 0, remaining, 0);
        attemptedRounds[round] = true;
        if (remaining == 0) return _result(round, Status.SoldOut, maxCount, 0, 0, 0);

        uint256 count = maxCount < remaining ? maxCount : remaining;
        uint256 first = collection.totalSupply() + 1;
        for (uint256 index; index < count; ++index) {
            TimedBenchmarkMintHelper helper = new TimedBenchmarkMintHelper(collection, recipient, round);
            if (helper.tokenId() != first + index) revert UnexpectedTokenSequence();
        }
        return _result(round, count == maxCount ? Status.Minted : Status.Partial,
            maxCount, count, collection.remainingSupply(), first);
    }

    function _result(uint256 round, Status status, uint256 requested, uint256 minted,
        uint256 remaining, uint256 firstTokenId) private returns (uint256, uint8) {
        emit BatchResult(round, uint8(status), requested, minted, remaining, firstTokenId);
        return (minted, uint8(status));
    }
}
