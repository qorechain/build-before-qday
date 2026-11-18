// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QDayVault} from "../src/QDayVault.sol";

/// Stand-ins for the QoreChain precompiles on Foundry's local EVM, which has
/// none. The real ones run on the testnet (see README, "Try it on chain").
/// A signature counts as valid here when it equals keccak256("ok", key, message).
contract MockPqc {
    bool public registered = true;
    bool public proven = true;
    bytes public key = hex"c0ffee";

    function set(bool registered_, bool proven_) external {
        registered = registered_;
        proven = proven_;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external pure returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(abi.encodePacked("ok", pubkey, message))));
    }

    function pqcKeyStatus(address) external view returns (bool, uint8, bytes memory, bool) {
        return (registered, 1, registered ? key : bytes(""), proven);
    }
}

contract QDayVaultTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    QDayVault vault;
    MockPqc keys;
    address guardian = makeAddr("guardian");
    address payable alice = payable(makeAddr("alice"));

    function setUp() public {
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        keys = MockPqc(PQC_KEYS);
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0101))); // registered = proven = true
        // key = hex"c0ffee" (short bytes layout: data left-aligned, length*2 in the last byte)
        vm.store(PQC_KEYS, bytes32(uint256(1)), bytes32(hex"c0ffee0000000000000000000000000000000000000000000000000000000006"));
        vault = new QDayVault{value: 5 ether}(guardian);
    }

    function sign(address to, uint256 amount, uint256 n) internal view returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked("ok", hex"c0ffee", vault.withdrawalMessage(to, amount, n))));
    }

    function test_withdrawWithGuardianSignature() public {
        vault.withdraw(alice, 1 ether, sign(alice, 1 ether, 0));
        assertEq(alice.balance, 1 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_anyoneMaySubmitTheSignedWithdrawal() public {
        vm.prank(makeAddr("relayer"));
        vault.withdraw(alice, 1 ether, sign(alice, 1 ether, 0));
        assertEq(alice.balance, 1 ether);
    }

    function test_revertsOnBadSignature() public {
        vm.expectRevert(QDayVault.BadPqcSignature.selector);
        vault.withdraw(alice, 1 ether, hex"deadbeef");
    }

    function test_signatureIsBoundToAmountAndRecipient() public {
        bytes memory sig = sign(alice, 1 ether, 0);
        vm.expectRevert(QDayVault.BadPqcSignature.selector);
        vault.withdraw(alice, 2 ether, sig);
        vm.expectRevert(QDayVault.BadPqcSignature.selector);
        vault.withdraw(payable(makeAddr("mallory")), 1 ether, sig);
    }

    function test_signatureWorksOnce() public {
        bytes memory sig = sign(alice, 1 ether, 0);
        vault.withdraw(alice, 1 ether, sig);
        vm.expectRevert(QDayVault.BadPqcSignature.selector);
        vault.withdraw(alice, 1 ether, sig);
    }

    function test_revertsWhenGuardianHasNoKey() public {
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0100))); // registered = false
        bytes memory sig = sign(alice, 1 ether, 0); // sign first: expectRevert applies to the next call
        vm.expectRevert(QDayVault.GuardianKeyNotRegistered.selector);
        vault.withdraw(alice, 1 ether, sig);
    }

    function test_revertsWhenKeyWasNotProven() public {
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0001))); // proven = false
        bytes memory sig = sign(alice, 1 ether, 0); // sign first: expectRevert applies to the next call
        vm.expectRevert(QDayVault.GuardianKeyNotProven.selector);
        vault.withdraw(alice, 1 ether, sig);
    }

    function test_acceptsDeposits() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 6 ether);
    }
}
