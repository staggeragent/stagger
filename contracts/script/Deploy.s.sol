// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {LadderManager} from "../src/LadderManager.sol";
import {StaggerStake} from "../src/StaggerStake.sol";

/// Robinhood Chain mainnet (4663). Simulate: ./deploy.sh   Broadcast: ./deploy.sh --broadcast
contract Deploy is Script {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint256 constant FEE_BPS = 500; // 5% of claimed swap fees, fixed forever

    function run() external {
        require(block.chainid == 4663, "wrong chain");
        vm.startBroadcast();
        StaggerStake stake = new StaggerStake(WETH);
        LadderManager ladder = new LadderManager(NPM, address(stake), FEE_BPS);
        vm.stopBroadcast();

        require(ladder.feeRecipient() == address(stake) && ladder.feeBps() == FEE_BPS, "wiring");
        console.log("StaggerStake ", address(stake));
        console.log("LadderManager", address(ladder));
        string memory j = string.concat(
            '{"chainId":4663,"StaggerStake":"', vm.toString(address(stake)),
            '","LadderManager":"', vm.toString(address(ladder)),
            '","feeBps":500,"deployer":"', vm.toString(stake.deployer()), '"}'
        );
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;
        vm.writeFile("../deployments/4663.json", j);
    }
}
