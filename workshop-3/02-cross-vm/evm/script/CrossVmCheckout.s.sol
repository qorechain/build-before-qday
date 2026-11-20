// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CrossVmCheckout} from "../src/CrossVmCheckout.sol";

/// Deploys CrossVmCheckout pointing at the Native receipts contract.
///   RECEIPTS_CONTRACT=qor1... forge script script/CrossVmCheckout.s.sol --rpc-url qorechain_testnet --broadcast
contract Deploy is Script {
    function run() external {
        string memory receipts = vm.envString("RECEIPTS_CONTRACT");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        CrossVmCheckout shop = new CrossVmCheckout(receipts);
        vm.stopBroadcast();
        console.log("CrossVmCheckout", address(shop));
    }
}
