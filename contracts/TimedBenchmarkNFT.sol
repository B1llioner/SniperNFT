// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITimedBenchmarkERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external returns (bytes4);
}

/// @notice Dedicated user-owned benchmark collection; unrelated to any external NFT sale.
/// @dev Ten consecutive one-second windows use chain block.timestamp, not wall-clock time.
///      One lifetime mint per msg.sender; transfers never restore mint eligibility.
///      Owner can arm once, but cannot bypass limits, mint administratively, or upgrade.
contract TimedBenchmarkNFT {
    uint256 public constant MAX_SUPPLY = 10_000;
    uint256 public constant ROUNDS = 10;
    string public constant name = "Timed Benchmark NFT";
    string public constant symbol = "TBNFT";
    address public immutable owner;
    bytes32 public immutable runId;
    uint256 public totalSupply;
    uint256 public startTime;
    mapping(address => bool) public hasMinted;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    error NotOwner();
    error AlreadyArmed();
    error InvalidStartTime();
    error InvalidRound();
    error NotArmed();
    error TooEarly();
    error Expired();
    error AlreadyMinted();
    error SoldOut();
    error InvalidAddress();
    error NonexistentToken();
    error NotAuthorized();
    error IncorrectOwner();
    error UnsafeRecipient();

    event Armed(uint256 startTime, uint256 endTime);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(bytes32 benchmarkRunId) {
        owner = msg.sender;
        runId = benchmarkRunId;
    }

    function arm(uint256 timestamp) external {
        if (msg.sender != owner) revert NotOwner();
        if (startTime != 0) revert AlreadyArmed();
        if (timestamp <= block.timestamp || timestamp > type(uint256).max - ROUNDS) revert InvalidStartTime();
        startTime = timestamp;
        emit Armed(timestamp, timestamp + ROUNDS);
    }

    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - totalSupply;
    }

    function mint(uint256 round) external returns (uint256 tokenId) {
        if (round >= ROUNDS) revert InvalidRound();
        uint256 start = startTime;
        if (start == 0) revert NotArmed();
        uint256 opens = start + round;
        if (block.timestamp < opens) revert TooEarly();
        if (block.timestamp >= opens + 1) revert Expired();
        if (hasMinted[msg.sender]) revert AlreadyMinted();
        if (totalSupply == MAX_SUPPLY) revert SoldOut();
        hasMinted[msg.sender] = true;
        tokenId = ++totalSupply;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
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
            try ITimedBenchmarkERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data)
                returns (bytes4 result) {
                if (result != ITimedBenchmarkERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }
}
