// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// QoreChain precompiles (active on the qorechain-diana testnet).
interface IQorePQC {
    /// ML-DSA-87 (FIPS 204) verification: 2592-byte key, 4627-byte signature.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);

    /// The ML-DSA-87 key an account registered on chain.
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @title QDayVault
/// @notice A vault that survives Q-Day: money leaves only with an ML-DSA-87
/// signature from the guardian. The guardian's post-quantum key is not stored
/// here; it is read from the chain's own key registry on every withdrawal, so
/// a key the guardian rotates on chain is picked up automatically.
///
/// Anyone may submit a withdrawal (a relayer, a bot, the guardian): what
/// authorises it is the ML-DSA-87 signature, not who sends it. A stolen
/// secp256k1 key alone cannot move anything.
contract QDayVault {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    /// The QoreChain account whose registered ML-DSA-87 key authorises withdrawals.
    address public immutable guardian;
    /// Increases with every withdrawal, so a signature works once.
    uint256 public nonce;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount, uint256 nonce);

    error GuardianKeyNotRegistered();
    error GuardianKeyNotProven();
    error BadPqcSignature();
    error TransferFailed();

    constructor(address guardian_) payable {
        guardian = guardian_;
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// The exact bytes the guardian signs for a withdrawal.
    function withdrawalMessage(address to, uint256 amount, uint256 nonce_) public view returns (bytes memory) {
        return abi.encodePacked("QDayVault:withdraw:v1", block.chainid, address(this), to, amount, nonce_);
    }

    function withdraw(address payable to, uint256 amount, bytes calldata mldsaSignature) external {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(guardian);
        if (!registered || pubkey.length == 0) revert GuardianKeyNotRegistered();
        if (!proven) revert GuardianKeyNotProven();

        uint256 n = nonce;
        if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, withdrawalMessage(to, amount, n))) revert BadPqcSignature();

        nonce = n + 1;
        emit Withdrawn(to, amount, n);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
