//! Only explicitly supported free SeaDrop / Genesis operations are encoded.
use alloy_sol_types::sol;

sol! {
    interface Factory {
        constructor(address nft_, address recipient_);
        function owner() external view returns (address);
        function recipient() external view returns (address);
        function nft() external view returns (address);
        function childCount() external view returns (uint256);
        function children(uint256 index) external view returns (address);
        function prepareChildren(uint256 count) external;
        function mintBatch(address seaDrop,address feeRecipient,uint256[] childIndices,bytes[] payloads,uint256 maxCount,uint256 gasPerChild) external returns (uint256 minted);
        event ChildMinted(uint256 indexed index,address indexed child,uint256 tokenId);
        event BatchResult(uint256 minted,uint256 attempted);
    }
    interface Child {
        function mint(address seaDrop,address feeRecipient,bytes payload) external returns(uint256);
        function spent() external view returns (bool);
    }
    interface Nft {
        function getAllowedSeaDrop() external view returns (address[]);
        function getMintStats(address minter) external view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply);
        function ownerOf(uint256 tokenId) external view returns (address);
        event Transfer(address indexed from,address indexed to,uint256 indexed tokenId);
    }
    interface Sea {
        struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime; uint16 maxTotalMintableByWallet; uint16 feeBps; bool restrictFeeRecipients; }
        struct Validation { uint80 minMintPrice; uint24 maxMaxTotalMintableByWallet; uint40 minStartTime; uint40 maxEndTime; uint40 maxMaxTokenSupplyForStage; uint16 minFeeBps; uint16 maxFeeBps; }
        function getPublicDrop(address nftContract) external view returns (PublicDrop);
        function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) external view returns (bool);
        function getSignedMintValidationParams(address nftContract,address signer) external view returns (Validation);
    }
    interface GasInfo {
        function getMaxTxGasLimit() external view returns (uint64);
    }
}
