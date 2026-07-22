// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";

/// @notice Deploys the AgentMesh stack with separated privileged roles.
///         Env:
///           USDC_ADDRESS       — existing USDC ERC-20 (Arc Testnet). If unset, deploys MockUSDC (local dev).
///           DISPUTE_WINDOW     — seconds, default 300 (local demo). Use >= 3600 on testnet.
///           ARBITER_ADDRESS    — escrow owner/arbiter, default deployer.
///           GATE_ADMIN_ADDRESS — compliance gate admin, default deployer.
///           SCREENER_ADDRESS   — gate screener (the watcher key), default deployer.
///           VERDICT_TTL        — gate verdict expiry seconds, default 0 (disabled).
///           AGENTMESH_NETWORK  — artifact name, default "local" → deployments/local.json.
contract Deploy is Script {
    function run() external {
        uint64 disputeWindow = uint64(vm.envOr("DISPUTE_WINDOW", uint256(300)));
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));
        uint64 verdictTtl = uint64(vm.envOr("VERDICT_TTL", uint256(0)));
        string memory network = vm.envOr("AGENTMESH_NETWORK", string("local"));

        vm.startBroadcast();
        address deployer = msg.sender;
        address arbiter = vm.envOr("ARBITER_ADDRESS", deployer);
        address gateAdmin = vm.envOr("GATE_ADMIN_ADDRESS", deployer);
        address screener = vm.envOr("SCREENER_ADDRESS", deployer);

        if (usdcAddr == address(0)) {
            MockUSDC mock = new MockUSDC();
            usdcAddr = address(mock);
            console.log("MockUSDC:", usdcAddr);
        }

        AgentRegistry registry = new AgentRegistry();
        // Deployer is gate admin during setup so it can wire roles, then hands
        // admin to gateAdmin and drops every role it doesn't explicitly keep.
        ComplianceGate gate = new ComplianceGate(deployer);
        AgentEscrow escrow = new AgentEscrow(IERC20(usdcAddr), IComplianceGate(address(gate)), disputeWindow, arbiter);

        if (verdictTtl != 0) gate.setVerdictTtl(verdictTtl);
        if (screener != deployer) {
            gate.grantRole(gate.SCREENER_ROLE(), screener);
            gate.revokeRole(gate.SCREENER_ROLE(), deployer);
        }
        if (gateAdmin != deployer) {
            gate.grantRole(gate.DEFAULT_ADMIN_ROLE(), gateAdmin);
            gate.revokeRole(gate.DEFAULT_ADMIN_ROLE(), deployer);
        }

        vm.stopBroadcast();

        console.log("USDC:", usdcAddr);
        console.log("AgentRegistry:", address(registry));
        console.log("ComplianceGate:", address(gate));
        console.log("AgentEscrow:", address(escrow));
        console.log("DisputeWindow:", disputeWindow);
        console.log("Arbiter:", arbiter);
        console.log("GateAdmin:", gateAdmin);
        console.log("Screener:", screener);

        // Machine-readable artifact consumed by the SDK's deployment loader.
        string memory obj = "deployment";
        vm.serializeString(obj, "network", network);
        vm.serializeAddress(obj, "usdc", usdcAddr);
        vm.serializeAddress(obj, "agentRegistry", address(registry));
        vm.serializeAddress(obj, "complianceGate", address(gate));
        vm.serializeAddress(obj, "agentEscrow", address(escrow));
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        string memory json = vm.serializeUint(obj, "disputeWindow", disputeWindow);
        string memory path = string.concat("../deployments/", network, ".json");
        vm.writeJson(json, path);
        console.log("artifact:", path);
    }
}
