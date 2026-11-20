// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CrossVmCheckout} from "../src/CrossVmCheckout.sol";

/// Stand-in for the CrossVM bridge: Foundry's EVM has no QoreChain precompiles.
/// It records the last call and refuses {"fail":{}} like the Native contract.
contract FakeBridge {
    uint8 public lastVm;
    string public lastTarget;
    bytes public lastPayload;
    uint256 public calls;

    function executeCrossVMCall(uint8 vm_, string calldata target, bytes calldata payload) external returns (bytes memory) {
        if (keccak256(payload) == keccak256('{"fail":{}}')) revert("refused on purpose by the Native contract");
        lastVm = vm_;
        lastTarget = target;
        lastPayload = payload;
        calls++;
        return bytes('{"id":1}');
    }
}

contract CrossVmCheckoutTest is Test {
    address constant BRIDGE = 0x0000000000000000000000000000000000000901;
    string constant TARGET = "qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8";
    CrossVmCheckout shop;

    function setUp() public {
        vm.etch(BRIDGE, address(new FakeBridge()).code);
        shop = new CrossVmCheckout(TARGET);
    }

    function test_checkoutCallsNativeWithExactMessage() public {
        bytes memory reply = shop.checkout("coffee for the team", false);
        assertEq(shop.orders(), 1);
        assertEq(reply, bytes('{"id":1}'));
        FakeBridge b = FakeBridge(BRIDGE);
        assertEq(b.lastVm(), 1);
        assertEq(b.lastTarget(), TARGET);
        assertEq(b.lastPayload(), bytes('{"record":{"note":"coffee for the team"}}'));
    }

    function test_failAfterRevertsEverything() public {
        vm.expectRevert(CrossVmCheckout.EvmSideFailed.selector);
        shop.checkout("will be undone", true);
        assertEq(shop.orders(), 0);
    }

    function test_nativeFailureRevertsEvmSide() public {
        vm.expectRevert();
        shop.checkoutNativeFails();
        assertEq(shop.orders(), 0);
    }

    function test_noteCannotInjectJson() public {
        vm.expectRevert(CrossVmCheckout.BadNote.selector);
        shop.checkout('x"}},"fail":{"', false);
        vm.expectRevert(CrossVmCheckout.BadNote.selector);
        shop.checkout("", false);
    }

    function test_inactiveBridgeIsAnError() public {
        vm.etch(BRIDGE, hex"");
        vm.expectRevert(CrossVmCheckout.BridgeNotActive.selector);
        shop.checkout("hello", false);
    }
}
