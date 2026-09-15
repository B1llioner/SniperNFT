// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IBenchmarkERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external returns (bytes4);
}

/// @notice Standalone ERC-721 for measuring deployment and mint transaction latency.
/// @dev No sale, metadata, external mint dependency, or cumulative supply cap. The
///      immutable deployer can mint repeatedly to itself; one call is bounded to
///      1,000 NFTs. Benchmark gas and execution differ from the real collection.
///      No payable entry points, upgrade mechanism, or mutable administrator.
contract SequencerBenchmarkNFT {
    address public immutable owner;
    bytes32 public immutable runId;
    uint256 public totalSupply;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    error NotOwner();
    error InvalidQuantity();
    error InvalidAddress();
    error NonexistentToken();
    error NotAuthorized();
    error IncorrectOwner();
    error UnsafeRecipient();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(bytes32 benchmarkRunId) {
        owner = msg.sender;
        runId = benchmarkRunId;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    /// @return firstTokenId The first newly minted ID; IDs start at one.
    function mint(uint256 quantity) external returns (uint256 firstTokenId) {
        if (msg.sender != owner) revert NotOwner();
        if (quantity == 0 || quantity > 1000) revert InvalidQuantity();
        firstTokenId = totalSupply + 1;
        uint256 end = totalSupply + quantity;
        totalSupply = end;
        _balances[owner] += quantity;
        for (uint256 tokenId = firstTokenId; tokenId <= end; ++tokenId) {
            _owners[tokenId] = owner;
            emit Transfer(address(0), owner, tokenId);
        }
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert InvalidAddress();
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address tokenOwner) {
        tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert NonexistentToken();
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _approvals[tokenId];
    }

    function approve(address approved, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !isApprovedForAll[tokenOwner][msg.sender]) revert NotAuthorized();
        _approvals[tokenId] = approved;
        emit Approval(tokenOwner, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address tokenOwner = ownerOf(tokenId);
        if (from != tokenOwner) revert IncorrectOwner();
        if (to == address(0)) revert InvalidAddress();
        if (msg.sender != tokenOwner && msg.sender != _approvals[tokenId]
            && !isApprovedForAll[tokenOwner][msg.sender]) revert NotAuthorized();
        delete _approvals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try IBenchmarkERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data)
                returns (bytes4 result) {
                if (result != IBenchmarkERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }
}
