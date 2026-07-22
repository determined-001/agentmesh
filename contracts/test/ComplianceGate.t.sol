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
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, rando, role)
        );
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
}
