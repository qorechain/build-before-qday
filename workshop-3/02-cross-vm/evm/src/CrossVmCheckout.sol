// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CrossVmCheckout
/// @notice An EVM contract that writes a receipt into a QoreChain Native
/// (CosmWasm) contract in the same transaction, through the CrossVM bridge
/// precompile at 0x...0901. Both sides succeed together or fail together.
contract CrossVmCheckout {
    /// The CrossVM bridge precompile.
    address public constant BRIDGE = 0x0000000000000000000000000000000000000901;
    /// Target VM 1 = QoreChain Native (CosmWasm).
    uint8 public constant NATIVE = 1;

    /// The Native receipts contract (bech32 qor1...). It must be on the
    /// bridge allowlist, which governance sets.
    string public receipts;
    /// Orders counted on the EVM side.
    uint256 public orders;

    event Ordered(uint256 indexed id, address indexed buyer, string note, bytes nativeReply);

    error BadNote();
    error EvmSideFailed();
    error BridgeCallFailed(bytes reason);
    error BridgeNotActive();

    constructor(string memory receiptsContract) {
        receipts = receiptsContract;
    }

    /// One order: count it here, and record a receipt on the Native side.
    /// With failAfter = true the EVM side fails AFTER the Native call
    /// succeeded, to show that the Native receipt is undone too.
    function checkout(string calldata note, bool failAfter) external returns (bytes memory reply) {
        _checkNote(bytes(note));
        orders += 1;
        reply = _callNative(bytes(string.concat('{"record":{"note":"', note, '"}}')));
        if (failAfter) revert EvmSideFailed();
        emit Ordered(orders, msg.sender, note, reply);
    }

    /// The Native contract refuses this call. The EVM order count goes up
    /// first, and is undone with the rest of the transaction.
    function checkoutNativeFails() external {
        orders += 1;
        _callNative(bytes('{"fail":{}}'));
    }

    function _callNative(bytes memory payload) private returns (bytes memory) {
        (bool ok, bytes memory ret) =
            BRIDGE.call(abi.encodeWithSignature("executeCrossVMCall(uint8,string,bytes)", NATIVE, receipts, payload));
        if (!ok) revert BridgeCallFailed(ret);
        // Where the precompile is not active, the call "succeeds" with no data.
        if (ret.length == 0) revert BridgeNotActive();
        // The bridge answers with the Native reply ABI-encoded as `bytes`
        // (published interface); older nodes returned the raw bytes.
        if (ret.length >= 64 && uint256(bytes32(ret)) == 32) return abi.decode(ret, (bytes));
        return ret;
    }

    /// The note goes into a JSON string: 1 to 140 printable ASCII
    /// characters, no quote and no backslash, so it cannot change the message.
    function _checkNote(bytes memory n) private pure {
        if (n.length == 0 || n.length > 140) revert BadNote();
        for (uint256 i; i < n.length; ++i) {
            bytes1 b = n[i];
            if (b < 0x20 || b > 0x7e || b == '"' || b == "\\") revert BadNote();
        }
    }
}
