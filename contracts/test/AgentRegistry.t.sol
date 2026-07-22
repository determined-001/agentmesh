// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        registry = new AgentRegistry();
    }

    function test_RegisterAndResolve() public {
        vm.prank(alice);
        uint256 tokenId = registry.register("databot", "http://localhost:4021", "ipfs://card1");

        assertEq(registry.ownerOf(tokenId), alice);
        (address wallet, AgentRegistry.AgentCard memory card) = registry.resolve("databot");
        assertEq(wallet, alice);
        assertEq(card.name, "databot");
        assertEq(card.endpoint, "http://localhost:4021");
        assertEq(card.cardURI, "ipfs://card1");
        assertEq(registry.totalAgents(), 1);
        assertTrue(registry.isRegistered("databot"));
    }

    function test_RevertOnDuplicateName() public {
        vm.prank(alice);
        registry.register("databot", "e1", "c1");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameTaken.selector, "databot"));
        registry.register("databot", "e2", "c2");
    }

    function test_RevertOnInvalidName() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameInvalid.selector, "Data_Bot"));
        registry.register("Data_Bot", "e", "c");
        vm.expectRevert(AgentRegistry.NameEmpty.selector);
        registry.register("", "e", "c");
    }

    function test_UpdateOnlyOwner() public {
        vm.prank(alice);
        registry.register("databot", "e1", "c1");

        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        registry.update("databot", "e2", "c2");

        vm.prank(alice);
        registry.update("databot", "e2", "c2");
        (, AgentRegistry.AgentCard memory card) = registry.resolve("databot");
        assertEq(card.endpoint, "e2");
    }

    function test_ListAgentsPagination() public {
        vm.startPrank(alice);
        registry.register("a1", "e", "c");
        registry.register("a2", "e", "c");
        registry.register("a3", "e", "c");
        vm.stopPrank();

        AgentRegistry.AgentCard[] memory page = registry.listAgents(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].name, "a2");
        assertEq(page[1].name, "a3");
        assertEq(registry.listAgents(5, 10).length, 0);
    }

    function test_ResolveFollowsTransfer() public {
        vm.prank(alice);
        uint256 tokenId = registry.register("databot", "e", "c");
        vm.prank(alice);
        registry.transferFrom(alice, bob, tokenId);
        (address wallet,) = registry.resolve("databot");
        assertEq(wallet, bob);
    }
}
