// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {QDayVault} from "../src/QDayVault.sol";

/// Deploys the vault with a first deposit. The guardian defaults to the deployer.
///   forge script script/QDayVault.s.sol --rpc-url qorechain_testnet --broadcast
contract DeployQDayVault is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address guardian = vm.envOr("GUARDIAN", vm.addr(key));
        uint256 deposit = vm.envOr("VAULT_DEPOSIT_WEI", uint256(1 ether));
        vm.startBroadcast(key);
        QDayVault vault = new QDayVault{value: deposit}(guardian);
        vm.stopBroadcast();
        console.log("QDayVault", address(vault));
        console.log("guardian ", guardian);
    }
}
