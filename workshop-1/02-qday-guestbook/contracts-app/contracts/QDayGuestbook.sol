// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title QDayGuestbook
/// @notice A public guestbook for the Build Before Q-Day workshops on the
///         QoreChain testnet. Anyone can sign once per address; messages are
///         short and stored on chain.
contract QDayGuestbook {
    struct Entry {
        address author;
        uint64 timestamp;
        string message;
    }

    uint256 public constant MAX_LENGTH = 140;

    Entry[] private entries;
    mapping(address => bool) public hasSigned;

    event Signed(uint256 indexed id, address indexed author, string message);

    error AlreadySigned();
    error BadLength();

    function sign(string calldata message) external {
        uint256 len = bytes(message).length;
        if (len == 0 || len > MAX_LENGTH) revert BadLength();
        if (hasSigned[msg.sender]) revert AlreadySigned();
        hasSigned[msg.sender] = true;
        entries.push(Entry(msg.sender, uint64(block.timestamp), message));
        emit Signed(entries.length - 1, msg.sender, message);
    }

    function count() external view returns (uint256) {
        return entries.length;
    }

    /// @notice The newest `limit` entries, newest first.
    function latest(uint256 limit) external view returns (Entry[] memory out) {
        uint256 n = entries.length;
        if (limit > n) limit = n;
        out = new Entry[](limit);
        for (uint256 i = 0; i < limit; i++) out[i] = entries[n - 1 - i];
    }
}
