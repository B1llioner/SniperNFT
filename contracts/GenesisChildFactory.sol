// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IGenesisChildNFT {
    function getAllowedSeaDrop() external view returns (address[] memory);
    function getMintStats(address minter) external view returns (uint256, uint256, uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IGenesisChildSeaDrop {
    struct PublicDrop {
        uint80 mintPrice;
        uint48 startTime;
        uint48 endTime;
        uint16 maxTotalMintableByWallet;
        uint16 feeBps;
        bool restrictFeeRecipients;
    }
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
    function getPublicDrop(address nft) external view returns (PublicDrop memory);
    function mintPublic(address nft, address feeRecipient, address minter, uint256 quantity) external payable;
    function mintSigned(address nft, address feeRecipient, address minter, uint256 quantity,
        MintParams calldata params, uint256 salt, bytes calldata signature) external payable;
}

/// @notice An inert, predeployed address that accepts fresh mint calldata only from its factory.
/// @dev This adapter is for free SeaDrop mints of sequential ERC721 IDs starting at one.
///      The SeaDrop contract remains responsible for signature validity and mint eligibility.
contract GenesisMintChild {
    address public immutable factory;
    address public immutable nft;
    address public immutable recipient;
    bool public spent;
    uint256 private expectedTokenId;

    error NotFactory();
    error AlreadyMinted();
    error InvalidPayload();
    error PaidMint();
    error InactiveStage();
    error SupplyUnavailable();
    error MintCallFailed(bytes4 reason);
    error UnexpectedMint();
    error UnexpectedTokenOwner();
    error UnexpectedCallback();

    constructor(address nft_, address recipient_) {
        factory = msg.sender;
        nft = nft_;
        recipient = recipient_;
    }

    function mint(address seaDrop, address feeRecipient, bytes calldata payload) external returns (uint256 tokenId) {
        if (msg.sender != factory) revert NotFactory();
        if (spent) revert AlreadyMinted();
        _validatePayload(seaDrop, feeRecipient, payload);
        (uint256 walletMinted, uint256 total, uint256 maximum) = IGenesisChildNFT(nft).getMintStats(address(this));
        if (walletMinted != 0) revert AlreadyMinted();
        if (total >= maximum) revert SupplyUnavailable();
        tokenId = total + 1;
        expectedTokenId = tokenId;
        // A failed mint or transfer reverts this write along with all child effects.
        spent = true;
        bytes memory callData = payload;
        bool ok;
        bytes4 reason;
        // Never copy an unbounded revert/return payload from the external mint route.
        assembly ("memory-safe") {
            ok := call(gas(), seaDrop, 0, add(callData, 32), mload(callData), 0, 0)
            if and(iszero(ok), gt(returndatasize(), 3)) {
                returndatacopy(0, 0, 4)
                reason := mload(0)
            }
        }
        if (!ok) revert MintCallFailed(reason);
        (, uint256 afterTotal,) = IGenesisChildNFT(nft).getMintStats(address(this));
        if (afterTotal != tokenId) revert UnexpectedMint();
        if (IGenesisChildNFT(nft).ownerOf(tokenId) != address(this)) revert UnexpectedTokenOwner();
        IGenesisChildNFT(nft).safeTransferFrom(address(this), recipient, tokenId);
        if (IGenesisChildNFT(nft).ownerOf(tokenId) != recipient) revert UnexpectedTokenOwner();
        expectedTokenId = 0;
    }

    function _validatePayload(address seaDrop, address feeRecipient, bytes calldata payload) private view {
        if (payload.length < 132 || payload.length > 1024) revert InvalidPayload();
        (address target, address fee, address minter, uint256 quantity) =
            abi.decode(payload[4:132], (address, address, address, uint256));
        if (target != nft || fee != feeRecipient || quantity != 1
            || (minter != address(0) && minter != address(this))) revert InvalidPayload();
        bytes4 selector = bytes4(payload[:4]);
        if (selector == IGenesisChildSeaDrop.mintPublic.selector) {
            // OpenSea may append its four-byte attribution suffix after canonical calldata.
            if (payload.length != 132 && payload.length != 136) revert InvalidPayload();
            IGenesisChildSeaDrop.PublicDrop memory drop = IGenesisChildSeaDrop(seaDrop).getPublicDrop(nft);
            if (drop.mintPrice != 0) revert PaidMint();
            if (block.timestamp < drop.startTime || block.timestamp > drop.endTime) revert InactiveStage();
            if (drop.maxTotalMintableByWallet == 0) revert SupplyUnavailable();
        } else if (selector == IGenesisChildSeaDrop.mintSigned.selector) {
            if (payload.length < 580) revert InvalidPayload();
            IGenesisChildSeaDrop.MintParams memory params =
                abi.decode(payload[132:388], (IGenesisChildSeaDrop.MintParams));
            uint256 signatureOffset = abi.decode(payload[420:452], (uint256));
            uint256 signatureLength = abi.decode(payload[452:484], (uint256));
            // The deployed SeaDrop's bytes-signature entry point accepts standard 65-byte ECDSA only.
            if (signatureOffset != 448 || signatureLength != 65) revert InvalidPayload();
            if (payload.length != 580 && payload.length != 584) revert InvalidPayload();
            if (params.mintPrice != 0) revert PaidMint();
            if (block.timestamp < params.startTime || block.timestamp > params.endTime) revert InactiveStage();
            (, uint256 total,) = IGenesisChildNFT(nft).getMintStats(address(this));
            if (params.maxTotalMintableByWallet == 0 || total >= params.maxTokenSupplyForStage) revert SupplyUnavailable();
        } else {
            revert InvalidPayload();
        }
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external view returns (bytes4) {
        if (msg.sender != nft || !spent || from != address(0) || expectedTokenId == 0
            || tokenId != expectedTokenId) revert UnexpectedCallback();
        return this.onERC721Received.selector;
    }
}

/// @notice Reusable free-mint factory. Invalid individual mints cannot undo earlier successes.
/// @dev Constructor addresses are permanent; mint routes/payloads are supplied afresh per batch.
///      No approvals, delegatecalls, arbitrary destinations, or ETH payments are supported.
contract GenesisChildFactory {
    uint256 public constant CHAIN_ID = 4663;
    uint256 public constant MAX_BATCH = 100;
    uint256 public constant MAX_CHILDREN = 1024;
    uint256 public constant MIN_GAS_PER_CHILD = 100_000;
    uint256 public constant MAX_GAS_PER_CHILD = 2_000_000;
    uint256 private constant STATS_GAS = 50_000;
    uint256 private constant PARENT_RESERVE = 100_000;
    address public immutable owner;
    address public immutable recipient;
    address public immutable nft;
    address[] public children;
    bool private entered;

    error WrongChain();
    error InvalidAddress();
    error NotOwner();
    error Reentrancy();
    error InvalidCount();
    error InvalidChild();
    error InvalidGasLimit();
    error InvalidPayloadSize();
    error RouteNotAllowed();

    event ChildPrepared(uint256 indexed index, address indexed child);
    event ChildMinted(uint256 indexed index, address indexed child, uint256 tokenId);
    event ChildFailed(uint256 indexed index, bytes4 reason);
    event BatchResult(uint256 minted, uint256 attempted);

    constructor(address nft_, address recipient_) {
        if (block.chainid != CHAIN_ID) revert WrongChain();
        if (nft_.code.length == 0 || recipient_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        recipient = recipient_;
        nft = nft_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        if (block.chainid != CHAIN_ID) revert WrongChain();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function childCount() external view returns (uint256) { return children.length; }

    /// @param count Number of additional children to deploy, between one and MAX_BATCH.
    function prepareChildren(uint256 count) external onlyOwner nonReentrant {
        if (count == 0 || count > MAX_BATCH || children.length + count > MAX_CHILDREN) revert InvalidCount();
        for (uint256 i; i < count; ++i) {
            address child = address(new GenesisMintChild(nft, recipient));
            uint256 index = children.length;
            children.push(child);
            emit ChildPrepared(index, child);
        }
    }

    /// @dev Returns zero for sold out/dependency failures. Check BatchResult, not receipt status alone.
    ///      All argument validation occurs before the first mint. Once minting begins, failures are isolated.
    function mintBatch(address seaDrop, address feeRecipient, uint256[] calldata childIndices,
        bytes[] calldata payloads, uint256 maxCount, uint256 gasPerChild)
        external onlyOwner nonReentrant returns (uint256 minted)
    {
        uint256 length = childIndices.length;
        if (length == 0 || length > MAX_BATCH || payloads.length != length || maxCount == 0 || maxCount > length) {
            revert InvalidCount();
        }
        if (gasPerChild < MIN_GAS_PER_CHILD || gasPerChild > MAX_GAS_PER_CHILD) revert InvalidGasLimit();
        for (uint256 i; i < length; ++i) {
            if (childIndices[i] >= children.length) revert InvalidChild();
            if (payloads[i].length > 1024) revert InvalidPayloadSize();
        }
        _checkRoute(seaDrop);
        uint256 failures;
        uint256 attempted;
        for (uint256 i; i < length && minted < maxCount; ++i) {
            // Reserve enough for the bounded read, EIP-150 call overhead and clean finalization.
            if (gasleft() < gasPerChild + gasPerChild / 63 + PARENT_RESERVE) break;
            (bool readable, uint256 total, uint256 maximum) = _readSupply();
            if (!readable || total >= maximum) break;
            address child = children[childIndices[i]];
            bytes memory callData = abi.encodeCall(GenesisMintChild.mint, (seaDrop, feeRecipient, payloads[i]));
            bool ok;
            uint256 returnSize;
            uint256 tokenId;
            bytes4 reason;
            assembly ("memory-safe") {
                ok := call(gasPerChild, child, 0, add(callData, 32), mload(callData), 0, 0)
                returnSize := returndatasize()
                if and(ok, eq(returnSize, 32)) {
                    returndatacopy(0, 0, 32)
                    tokenId := mload(0)
                }
                if and(iszero(ok), gt(returnSize, 3)) {
                    returndatacopy(0, 0, 4)
                    reason := mload(0)
                }
            }
            ++attempted;
            if (ok && returnSize == 32 && tokenId != 0) {
                ++minted;
                failures = 0;
                emit ChildMinted(childIndices[i], child, tokenId);
            } else {
                emit ChildFailed(childIndices[i], reason);
                if (++failures == 3) break;
            }
        }
        emit BatchResult(minted, attempted);
    }

    function _checkRoute(address seaDrop) private view {
        if (seaDrop.code.length == 0) revert RouteNotAllowed();
        address[] memory allowed = IGenesisChildNFT(nft).getAllowedSeaDrop();
        for (uint256 i; i < allowed.length; ++i) if (allowed[i] == seaDrop) return;
        revert RouteNotAllowed();
    }

    function _readSupply() private view returns (bool ok, uint256 total, uint256 maximum) {
        bytes memory data = abi.encodeCall(IGenesisChildNFT.getMintStats, (address(0)));
        address target = nft;
        uint256 budget = STATS_GAS;
        // A bad/dead getter after an earlier success must not bubble a revert or exhaust this batch.
        assembly ("memory-safe") {
            let output := mload(0x40)
            ok := staticcall(budget, target, add(data, 32), mload(data), output, 96)
            ok := and(ok, eq(returndatasize(), 96))
            if ok {
                total := mload(add(output, 32))
                maximum := mload(add(output, 64))
            }
        }
    }
}
