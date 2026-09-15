// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

address constant RARE_FRIENDS_NFT = 0x116EaA62241751E0c98dA43d458600c6C17cD361;
address constant RARE_FRIENDS_SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
address constant RARE_FRIENDS_FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;

interface IRareFriendsNFT {
    function getMintStats(address minter) external view returns (uint256, uint256, uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IRareFriendsSeaDrop {
    struct PublicDrop {
        uint80 mintPrice;
        uint48 startTime;
        uint48 endTime;
        uint16 maxTotalMintableByWallet;
        uint16 feeBps;
        bool restrictFeeRecipients;
    }

    function getPublicDrop(address nftContract) external view returns (PublicDrop memory);
    function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)
        external payable;
}

/// @dev All work happens during construction. The deployed helper has no callable functions.
contract RareFriendsMintHelper {
    error UnexpectedMint(uint256 totalMinted, uint256 expectedTokenId);
    error UnexpectedTokenOwner(uint256 tokenId);

    constructor(address recipient, uint256 expectedTokenId) {
        IRareFriendsSeaDrop(RARE_FRIENDS_SEADROP).mintPublic(
            RARE_FRIENDS_NFT, RARE_FRIENDS_FEE_RECIPIENT, address(0), 1
        );
        IRareFriendsNFT nft = IRareFriendsNFT(RARE_FRIENDS_NFT);
        (, uint256 totalMinted,) = nft.getMintStats(address(this));
        // This NFT uses sequential IDs starting at 1; verify the counter and actual owner.
        if (totalMinted != expectedTokenId) revert UnexpectedMint(totalMinted, expectedTokenId);
        if (nft.ownerOf(expectedTokenId) != address(this)) revert UnexpectedTokenOwner(expectedTokenId);
        nft.safeTransferFrom(address(this), recipient, expectedTokenId);
        if (nft.ownerOf(expectedTokenId) != recipient) revert UnexpectedTokenOwner(expectedTokenId);
    }
}

/// @notice Atomically mint a configured number of free public-drop NFTs through fresh helpers.
contract RareFriendsBatchMinter {
    uint256 public constant CHAIN_ID = 4663;
    // Collection-wide hard cap; practical batch size is also limited by transaction gas.
    uint256 public constant MAX_BATCH_SIZE = 1024;
    address public immutable owner;
    address public immutable recipient;
    bool private entered;

    error WrongChain(uint256 chainId);
    error ZeroRecipient();
    error NotOwner();
    error Reentrancy();
    error InvalidCount();
    error PaidMint(uint256 mintPrice);
    error InactiveStage(uint256 timestamp, uint256 startTime, uint256 endTime);
    error WalletMintDisabled();
    error InsufficientSupply(uint256 remaining, uint256 minimum);

    event TokenMinted(address indexed helper, address indexed recipient, uint256 indexed tokenId);
    event BatchMinted(address indexed recipient, uint256 count);

    constructor(address recipient_) {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        if (recipient_ == address(0)) revert ZeroRecipient();
        owner = msg.sender;
        recipient = recipient_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    /// @param maxCount Upper bound, between 1 and 1024 (also subject to available gas and supply).
    /// @param minCount Minimum acceptable remaining supply; equal maxCount to require the full batch.
    /// @return count NFTs minted and transferred. Any helper/transfer failure reverts the entire batch.
    function mintBatch(uint256 maxCount, uint256 minCount)
        external onlyOwner nonReentrant returns (uint256 count)
    {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        if (minCount == 0 || minCount > maxCount || maxCount > MAX_BATCH_SIZE) revert InvalidCount();
        IRareFriendsSeaDrop.PublicDrop memory drop =
            IRareFriendsSeaDrop(RARE_FRIENDS_SEADROP).getPublicDrop(RARE_FRIENDS_NFT);
        if (drop.mintPrice != 0) revert PaidMint(drop.mintPrice);
        if (block.timestamp < drop.startTime || block.timestamp > drop.endTime) {
            revert InactiveStage(block.timestamp, drop.startTime, drop.endTime);
        }
        if (drop.maxTotalMintableByWallet == 0) revert WalletMintDisabled();

        (, uint256 totalMinted, uint256 maxSupply) =
            IRareFriendsNFT(RARE_FRIENDS_NFT).getMintStats(address(0));
        uint256 remaining = maxSupply > totalMinted ? maxSupply - totalMinted : 0;
        count = remaining < maxCount ? remaining : maxCount;
        if (count < minCount) revert InsufficientSupply(remaining, minCount);

        for (uint256 i; i < count; ++i) {
            uint256 tokenId = totalMinted + i + 1;
            RareFriendsMintHelper helper = new RareFriendsMintHelper(recipient, tokenId);
            emit TokenMinted(address(helper), recipient, tokenId);
        }
        emit BatchMinted(recipient, count);
    }
}
