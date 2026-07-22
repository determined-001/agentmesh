// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract ComplianceGateTest is Test {
    ComplianceGate gate;
    address admin = makeAddr("admin");
    address screener = makeAddr("screener");
    address agent = makeAddr("agent");
    address rando = makeAddr("rando");

    function setUp() public {
        gate = new ComplianceGate(admin);
    }

    function test_DefaultDenied() public view {
        assertFalse(gate.isAllowed(agent));
    }

    function test_AdminScreens() public {
        vm.prank(admin);
        gate.setAllowed(agent, true, keccak256("clean"));
        assertTrue(gate.isAllowed(agent));

        vm.prank(admin);
        gate.setAllowed(agent, false, keccak256("flagged"));
        assertFalse(gate.isAllowed(agent));
    }

    function test_ScreenerRoleGrantable() public {
        bytes32 role = gate.SCREENER_ROLE();
        vm.prank(admin);
        gate.grantRole(role, screener);
        vm.prank(screener);
        gate.setAllowed(agent, true, keccak256("clean"));
        assertTrue(gate.isAllowed(agent));
    }

    function test_RandoCannotScreen() public {
        bytes32 role = gate.SCREENER_ROLE();
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, rando, role));
        gate.setAllowed(agent, true, bytes32(0));
    }

    function test_Batch() public {
        address[] memory accounts = new address[](2);
        accounts[0] = agent;
        accounts[1] = rando;
        vm.prank(admin);
        gate.setAllowedBatch(accounts, true, keccak256("batch"));
        assertTrue(gate.isAllowed(agent));
        assertTrue(gate.isAllowed(rando));
    }

    function test_ScreenedEventEmitted() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit ComplianceGate.Screened(agent, true, keccak256("clean"), admin);
        gate.setAllowed(agent, true, keccak256("clean"));
    }

    // ── verdict TTL ─────────────────────────────────────────────────────

    function test_TtlZeroNeverExpires() public {
        vm.prank(admin);
        gate.setAllowed(agent, true, keccak256("clean"));
        vm.warp(block.timestamp + 100 * 365 days);
        assertTrue(gate.isAllowed(agent)); // default ttl = 0 → no expiry
    }

    function test_TtlExpiresAllowedVerdict() public {
        vm.startPrank(admin);
        gate.setVerdictTtl(1 days);
        gate.setAllowed(agent, true, keccak256("clean"));
        vm.stopPrank();

        assertTrue(gate.isAllowed(agent));
        vm.warp(block.timestamp + 1 days); // exactly at boundary: still valid
        assertTrue(gate.isAllowed(agent));
        vm.warp(block.timestamp + 1); // past boundary: stale
        assertFalse(gate.isAllowed(agent));

        // re-screening refreshes
        vm.prank(admin);
        gate.setAllowed(agent, true, keccak256("re-screened"));
        assertTrue(gate.isAllowed(agent));
    }

    function test_TtlNeverRevivesDeniedVerdict() public {
        vm.startPrank(admin);
        gate.setVerdictTtl(1 days);
        gate.setAllowed(agent, false, keccak256("flagged"));
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        assertFalse(gate.isAllowed(agent));
    }

    function test_SetVerdictTtlAdminOnlyAndEmits() public {
        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, rando, bytes32(0))
        );
        gate.setVerdictTtl(1 hours);

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit ComplianceGate.VerdictTtlSet(0, 1 hours);
        gate.setVerdictTtl(1 hours);
        assertEq(gate.verdictTtl(), 1 hours);
    }
}
