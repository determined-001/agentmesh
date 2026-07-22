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
        registry.register("ag1", "e", "c");
        registry.register("ag2", "e", "c");
        registry.register("ag3", "e", "c");
        vm.stopPrank();

        AgentRegistry.AgentCard[] memory page = registry.listAgents(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].name, "ag2");
        assertEq(page[1].name, "ag3");
        assertEq(registry.listAgents(5, 10).length, 0);
        assertEq(registry.listAgents(3, 10).length, 0); // offset == n edge
    }

    function test_ResolveFollowsTransfer() public {
        vm.prank(alice);
        uint256 tokenId = registry.register("databot", "e", "c");
        vm.prank(alice);
        registry.transferFrom(alice, bob, tokenId);
        (address wallet,) = registry.resolve("databot");
        assertEq(wallet, bob);
    }

    function test_TransferUpdatesCardWalletAndEmits() public {
        vm.prank(alice);
        uint256 tokenId = registry.register("databot", "e", "c");

        vm.prank(alice);
        vm.expectEmit(true, true, true, false);
        emit AgentRegistry.AgentWalletChanged(tokenId, alice, bob);
        registry.transferFrom(alice, bob, tokenId);

        // card.wallet follows ownership — payment routing moves with the name
        (, AgentRegistry.AgentCard memory card) = registry.resolve("databot");
        assertEq(card.wallet, bob);
    }

    function test_RevertOnNameLength() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameLength.selector, "ab"));
        registry.register("ab", "e", "c");
        string memory tooLong = "a234567890123456789012345678901234"; // 34 chars
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameLength.selector, tooLong));
        registry.register(tooLong, "e", "c");
        // boundaries are legal
        vm.startPrank(alice);
        registry.register("abc", "e", "c");
        registry.register("a2345678901234567890123456789012", "e", "c"); // 32 chars
        vm.stopPrank();
    }

    function test_ReentrantRegisterCannotStealName() public {
        ReentrantReceiver attacker = new ReentrantReceiver(registry);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameTaken.selector, "sneaky"));
        attacker.go("sneaky");
    }

    function test_TokenURIReturnsCardURI() public {
        vm.prank(alice);
        uint256 tokenId = registry.register("databot", "e", "ipfs://card1");
        assertEq(registry.tokenURI(tokenId), "ipfs://card1");
    }

    function test_UnregisteredNameReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotRegistered.selector, "ghost"));
        registry.resolve("ghost");
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotRegistered.selector, "ghost"));
        registry.update("ghost", "e", "c");
        assertFalse(registry.isRegistered("ghost"));
    }

    function testFuzz_NameCharsetEnforced(bytes1 c) public {
        bool valid = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d;
        string memory name = string(abi.encodePacked("ab", c));
        vm.prank(alice);
        if (valid) {
            registry.register(name, "e", "c");
            assertTrue(registry.isRegistered(name));
        } else {
            vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NameInvalid.selector, name));
            registry.register(name, "e", "c");
        }
    }
}

/// @dev Attempts to re-register the same name from inside onERC721Received.
contract ReentrantReceiver {
    AgentRegistry private immutable registry;
    string private name;

    constructor(AgentRegistry registry_) {
        registry = registry_;
    }

    function go(string calldata name_) external {
        name = name_;
        registry.register(name_, "e", "c");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        registry.register(name, "e2", "c2"); // must revert NameTaken → bubbles up
        return this.onERC721Received.selector;
    }
}
