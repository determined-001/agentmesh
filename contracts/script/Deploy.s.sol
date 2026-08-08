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
///           RESOLVE_TIMEOUT    — seconds after delivery before anyone may refund a
///                                stuck job, default 7 days. Must exceed DISPUTE_WINDOW.
///           ARBITER_ADDRESS    — escrow owner/arbiter, default deployer.
///           GATE_ADMIN_ADDRESS — compliance gate admin, default deployer.
///           SCREENER_ADDRESS   — gate screener (the watcher key), default deployer.
///           GATE_ADMIN_DELAY   — seconds an admin handover waits, default 2 days.
///           VERDICT_TTL        — gate verdict expiry seconds, default 0 (disabled).
///                                Only applied when GATE_ADMIN_ADDRESS is the deployer.
///         For production, set ARBITER_ADDRESS, GATE_ADMIN_ADDRESS and SCREENER_ADDRESS
///         to three DISTINCT wallets: only the screener needs to be online.
///           AGENTMESH_NETWORK  — artifact name, default "local" → deployments/local.json.
contract Deploy is Script {
    /// @dev Grouped rather than kept as locals: `run()` otherwise exceeds the
    ///      EVM's 16-slot stack window ("Stack too deep") without via-ir.
    struct Config {
        uint64 disputeWindow;
        uint64 resolveTimeout;
        uint64 verdictTtl;
        uint48 adminDelay;
        address usdc;
        address arbiter;
        address gateAdmin;
        address screener;
        string network;
    }

    struct Deployed {
        address registry;
        address gate;
        address escrow;
    }

    function run() external {
        Config memory cfg = _config();

        vm.startBroadcast();
        if (cfg.usdc == address(0)) {
            cfg.usdc = address(new MockUSDC());
            console.log("MockUSDC:", cfg.usdc);
        }

        AgentRegistry registry = new AgentRegistry();
        // Roles are wired in the constructor, so the deployer never holds admin
        // and there is no post-deploy revoke that can be forgotten. (Under
        // AccessControlDefaultAdminRules a later admin handover is the two-step
        // beginDefaultAdminTransfer / acceptDefaultAdminTransfer flow.)
        ComplianceGate gate = new ComplianceGate(cfg.adminDelay, cfg.gateAdmin, cfg.screener);
        AgentEscrow escrow = new AgentEscrow(
            IERC20(cfg.usdc), IComplianceGate(address(gate)), cfg.disputeWindow, cfg.resolveTimeout, cfg.arbiter
        );

        // setVerdictTtl is admin-only and admin is gateAdmin from birth, so the
        // deployer can only set it when it is itself the gate admin.
        if (cfg.verdictTtl != 0) {
            if (cfg.gateAdmin == msg.sender) {
                gate.setVerdictTtl(cfg.verdictTtl);
            } else {
                console.log("NOTE: VERDICT_TTL not applied - call setVerdictTtl as gateAdmin:", cfg.verdictTtl);
            }
        }
        vm.stopBroadcast();

        _report(cfg, Deployed(address(registry), address(gate), address(escrow)));
    }

    function _config() private view returns (Config memory cfg) {
        address deployer = msg.sender;
        cfg = Config({
            disputeWindow: uint64(vm.envOr("DISPUTE_WINDOW", uint256(300))),
            resolveTimeout: uint64(vm.envOr("RESOLVE_TIMEOUT", uint256(7 days))),
            verdictTtl: uint64(vm.envOr("VERDICT_TTL", uint256(0))),
            adminDelay: uint48(vm.envOr("GATE_ADMIN_DELAY", uint256(2 days))),
            usdc: vm.envOr("USDC_ADDRESS", address(0)),
            arbiter: vm.envOr("ARBITER_ADDRESS", deployer),
            gateAdmin: vm.envOr("GATE_ADMIN_ADDRESS", deployer),
            screener: vm.envOr("SCREENER_ADDRESS", deployer),
            network: vm.envOr("AGENTMESH_NETWORK", string("local"))
        });
    }

    function _report(Config memory cfg, Deployed memory d) private {
        console.log("USDC:", cfg.usdc);
        console.log("AgentRegistry:", d.registry);
        console.log("ComplianceGate:", d.gate);
        console.log("AgentEscrow:", d.escrow);
        console.log("DisputeWindow:", cfg.disputeWindow);
        console.log("ResolveTimeout:", cfg.resolveTimeout);
        console.log("Arbiter:", cfg.arbiter);
        console.log("GateAdmin:", cfg.gateAdmin);
        console.log("Screener:", cfg.screener);
        if (cfg.arbiter == cfg.gateAdmin || cfg.arbiter == cfg.screener || cfg.gateAdmin == cfg.screener) {
            console.log("WARNING: privileged roles share an address - separate them before real funds");
        }

        // Machine-readable artifact consumed by the SDK's deployment loader.
        string memory obj = "deployment";
        vm.serializeString(obj, "network", cfg.network);
        vm.serializeAddress(obj, "usdc", cfg.usdc);
        vm.serializeAddress(obj, "agentRegistry", d.registry);
        vm.serializeAddress(obj, "complianceGate", d.gate);
        vm.serializeAddress(obj, "agentEscrow", d.escrow);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        vm.serializeUint(obj, "disputeWindow", cfg.disputeWindow);
        string memory json = vm.serializeUint(obj, "resolveTimeout", cfg.resolveTimeout);
        string memory path = string.concat("../deployments/", cfg.network, ".json");
        vm.writeJson(json, path);
        console.log("artifact:", path);
    }
}
