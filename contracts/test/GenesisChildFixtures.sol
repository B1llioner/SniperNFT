// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IGenesisChildSeaDrop, GenesisChildFactory} from "contracts/GenesisChildFactory.sol";

interface IChildReceiver {
    function onERC721Received(address operator, address from, uint256 token, bytes calldata data) external returns (bytes4);
}

/// @dev Local test double, not a production ERC721 implementation or Genesis source reconstruction.
contract MockGenesisChildNFT {
    address public immutable owner = msg.sender;
    address[] private allowed;
    uint256 public total;
    uint256 public immutable maximum;
    uint256 public failFactoryStatsAt;
    mapping(address => uint256) public walletMinted;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 indexed token);

    constructor(uint256 initial, uint256 max_) { require(initial <= max_); total = initial; maximum = max_; }
    function setRoute(address route) external { require(msg.sender == owner); delete allowed; allowed.push(route); }
    function setFailFactoryStatsAt(uint256 number) external { require(msg.sender == owner); failFactoryStatsAt = number; }
    function getAllowedSeaDrop() external view returns (address[] memory) { return allowed; }
    function getMintStats(address minter) external view returns (uint256, uint256, uint256) {
        require(minter != address(0) || failFactoryStatsAt == 0 || total < failFactoryStatsAt, "getter failure");
        return (walletMinted[minter], total, maximum);
    }
    function mintSeaDrop(address minter, uint256 quantity) external {
        require(allowed.length == 1 && msg.sender == allowed[0], "route");
        require(quantity == 1 && walletMinted[minter] == 0 && total < maximum, "mint limit");
        walletMinted[minter] = 1;
        uint256 token = ++total;
        ownerOf[token] = minter;
        ++balanceOf[minter];
        emit Transfer(address(0), minter, token);
        if (minter.code.length != 0) require(
            IChildReceiver(minter).onERC721Received(msg.sender, address(0), token, "") == IChildReceiver.onERC721Received.selector,
            "mint callback"
        );
    }
    function safeTransferFrom(address from, address to, uint256 token) external {
        require(msg.sender == from && ownerOf[token] == from && to != address(0), "owner");
        ownerOf[token] = to;
        --balanceOf[from];
        ++balanceOf[to];
        emit Transfer(from, to, token);
        if (to.code.length != 0) require(
            IChildReceiver(to).onERC721Received(msg.sender, from, token, "") == IChildReceiver.onERC721Received.selector,
            "transfer callback"
        );
    }
}

/// @dev Local SeaDrop-compatible signature double. It deliberately implements only exercised paths.
///      EIP-712 hashing mirrors the checked-in SeaDrop source; this is not production cryptography.
contract MockGenesisChildSeaDrop is IGenesisChildSeaDrop {
    struct Validation {
        uint80 minMintPrice;
        uint24 maxMaxTotalMintableByWallet;
        uint40 minStartTime;
        uint40 maxEndTime;
        uint40 maxMaxTokenSupplyForStage;
        uint16 minFeeBps;
        uint16 maxFeeBps;
    }
    bytes32 private constant PARAMS_TYPEHASH = keccak256("MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)");
    bytes32 private constant SIGNED_TYPEHASH = keccak256("SignedMint(address nftContract,address minter,address feeRecipient,MintParams mintParams,uint256 salt)MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)");
    address public signer;
    address public immutable feeRecipient;
    address public immutable owner = msg.sender;
    PublicDrop private drop;
    mapping(bytes32 => bool) public used;
    mapping(address => uint256) public failureMode;
    error InvalidSignature();
    error InjectedFailure();

    constructor(address signer_, address fee_) {
        signer = signer_; feeRecipient = fee_;
        drop = PublicDrop(0, 1, type(uint48).max, 1, 1000, true);
    }
    function setSigner(address value) external { require(msg.sender == owner); signer = value; }
    function setDrop(PublicDrop calldata value) external { require(msg.sender == owner); drop = value; }
    function setFailure(address minter, uint256 mode) external { require(msg.sender == owner); failureMode[minter] = mode; }
    function getPublicDrop(address) external view returns (PublicDrop memory) { return drop; }
    function getFeeRecipientIsAllowed(address, address candidate) external view returns (bool) { return candidate == feeRecipient; }
    function getSignedMintValidationParams(address, address candidate) external view returns (Validation memory) {
        if (candidate != signer) return Validation(0, 0, 0, 0, 0, 0, 0);
        return Validation(0, 1, 1, type(uint40).max, type(uint40).max, 0, 10000);
    }
    function mintPublic(address nft, address fee, address minter_, uint256 quantity) external payable {
        address minter = minter_ == address(0) ? msg.sender : minter_;
        require(minter == msg.sender && fee == feeRecipient && quantity == 1 && msg.value == drop.mintPrice, "arguments");
        require(block.timestamp >= drop.startTime && block.timestamp <= drop.endTime && drop.maxTotalMintableByWallet != 0, "stage");
        _mint(nft, minter);
    }
    function mintSigned(address nft, address fee, address minter_, uint256 quantity,
        MintParams calldata params, uint256 salt, bytes calldata signature) external payable
    {
        address minter = minter_ == address(0) ? msg.sender : minter_;
        require(minter == msg.sender && fee == feeRecipient && quantity == 1 && msg.value == params.mintPrice, "arguments");
        require(block.timestamp >= params.startTime && block.timestamp <= params.endTime, "stage");
        (uint256 wallet, uint256 total,) = MockGenesisChildNFT(nft).getMintStats(minter);
        require(wallet < params.maxTotalMintableByWallet && total < params.maxTokenSupplyForStage, "limits");
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SeaDrop"), keccak256("1.0"), block.chainid, address(this)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain,
            keccak256(abi.encode(SIGNED_TYPEHASH, nft, minter, fee, keccak256(abi.encode(PARAMS_TYPEHASH, params)), salt))));
        bytes32 r; bytes32 s; uint8 v;
        if (signature.length == 65) {
            assembly ("memory-safe") { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        } else { revert InvalidSignature(); }
        if (used[digest] || signer == address(0) || ecrecover(digest, v, r, s) != signer) revert InvalidSignature();
        used[digest] = true;
        _mint(nft, minter);
    }
    function _mint(address nft, address minter) private {
        uint256 mode = failureMode[minter];
        if (mode == 1) revert InjectedFailure();
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        if (mode == 3) { assembly ("memory-safe") { revert(0, 65536) } }
        MockGenesisChildNFT(nft).mintSeaDrop(minter, 1);
    }
}

contract GenesisChildTestReceiver is IChildReceiver {
    bool public reject;
    address public factory;
    bool public reentryRejected;
    function configure(address factory_, bool reject_) external { factory = factory_; reject = reject_; }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!reject, "receiver rejects");
        (bool ok,) = factory.call(abi.encodeWithSignature("prepareChildren(uint256)", 1));
        reentryRejected = !ok;
        return this.onERC721Received.selector;
    }
}

/// @dev Exercises nonReentrant after passing onlyOwner; this receiver owns its test factory.
contract GenesisChildOwnerReceiver is IChildReceiver {
    GenesisChildFactory public immutable factory;
    bool public reentryRejected;
    constructor(address nft) { factory = new GenesisChildFactory(nft, address(this)); }
    function prepare() external { factory.prepareChildren(1); }
    function runMint(address route, address fee, bytes calldata payload) external {
        uint256[] memory indices = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = payload;
        factory.mintBatch(route, fee, indices, payloads, 1, 500000);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        (bool ok, bytes memory reason) = address(factory).call(abi.encodeCall(GenesisChildFactory.prepareChildren, (1)));
        require(!ok && reason.length == 4 && bytes4(reason) == GenesisChildFactory.Reentrancy.selector, "guard");
        reentryRejected = true;
        return this.onERC721Received.selector;
    }
}
