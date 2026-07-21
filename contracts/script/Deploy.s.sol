// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";

/// @notice Deploys the AgentMesh stack.
///         Env:
///           USDC_ADDRESS   — existing USDC ERC-20 (Arc Testnet). If unset, deploys MockUSDC (local dev).
///           DISPUTE_WINDOW — seconds, default 300.
contract Deploy is Script {
    function run() external {
        uint64 disputeWindow = uint64(vm.envOr("DISPUTE_WINDOW", uint256(300)));
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));

        vm.startBroadcast();
        address deployer = msg.sender;

        if (usdcAddr == address(0)) {
            MockUSDC mock = new MockUSDC();
            usdcAddr = address(mock);
            console.log("MockUSDC:", usdcAddr);
        }

        AgentRegistry registry = new AgentRegistry();
        ComplianceGate gate = new ComplianceGate(deployer);
        AgentEscrow escrow = new AgentEscrow(IERC20(usdcAddr), IComplianceGate(address(gate)), disputeWindow, deployer);

        vm.stopBroadcast();

        console.log("USDC:", usdcAddr);
        console.log("AgentRegistry:", address(registry));
        console.log("ComplianceGate:", address(gate));
        console.log("AgentEscrow:", address(escrow));
        console.log("DisputeWindow:", disputeWindow);
    }
}
