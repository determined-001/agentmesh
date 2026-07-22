// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";

contract AgentEscrowTest is Test {
    MockUSDC usdc;
    ComplianceGate gate;
    AgentEscrow escrow;

    address arbiter = makeAddr("arbiter");
    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address watcher = makeAddr("watcher");

    uint64 constant DISPUTE_WINDOW = 1 hours;
    uint256 constant AMOUNT = 5_000_000; // $5, 6 decimals

    function setUp() public {
        usdc = new MockUSDC();
        gate = new ComplianceGate(arbiter);
        escrow = new AgentEscrow(IERC20(address(usdc)), IComplianceGate(address(gate)), DISPUTE_WINDOW, arbiter);

        usdc.mint(buyer, 100_000_000);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(arbiter);
        gate.setAllowed(seller, true, keccak256("clean"));
    }

    function _createJob() internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId = escrow.createJob(seller, AMOUNT, uint64(block.timestamp + 1 days), keccak256("spec"));
    }

    function test_HappyPath_BuyerReleases() public {
        uint256 jobId = _createJob();
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(buyer);
        escrow.release(jobId);

        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentEscrow.JobStatus.Released));
    }

    function test_WatcherReleasesAfterDisputeWindow() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(watcher);
        vm.expectRevert(AgentEscrow.DisputeWindowOpen.selector);
        escrow.release(jobId);

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.prank(watcher);
        escrow.release(jobId);
        assertEq(usdc.balanceOf(seller), AMOUNT);
    }

    function test_ComplianceBlocksRelease() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(arbiter);
        gate.setAllowed(seller, false, keccak256("sanctioned"));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.ComplianceBlocked.selector, seller));
        escrow.release(jobId);
    }

    function test_DisputeThenArbiterRefunds() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("bad-report"));

        vm.prank(buyer);
        escrow.dispute(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentEscrow.JobStatus.Disputed));

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, false);
        assertEq(usdc.balanceOf(buyer), 100_000_000);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentEscrow.JobStatus.Refunded));
    }

    function test_DisputeThenArbiterReleases() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));
        vm.prank(buyer);
        escrow.dispute(jobId);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, true);
        assertEq(usdc.balanceOf(seller), AMOUNT);
    }

    function test_DisputeClosesAfterWindow() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.DisputeWindowClosed.selector);
        escrow.dispute(jobId);
    }

    function test_RefundAfterDeadline() public {
        uint256 jobId = _createJob();

        vm.expectRevert(AgentEscrow.DeadlineNotPassed.selector);
        escrow.refund(jobId);

        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(jobId);
        assertEq(usdc.balanceOf(buyer), 100_000_000);
    }

    function test_DeliverAfterDeadlineReverts() public {
        uint256 jobId = _createJob();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(seller);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.deliver(jobId, keccak256("late"));
    }

    function test_OnlySellerDelivers() public {
        uint256 jobId = _createJob();
        vm.prank(buyer);
        vm.expectRevert(AgentEscrow.NotSeller.selector);
        escrow.deliver(jobId, keccak256("x"));
    }

    function test_CreateJobValidation() public {
        vm.startPrank(buyer);
        vm.expectRevert(AgentEscrow.InvalidParams.selector);
        escrow.createJob(address(0), AMOUNT, uint64(block.timestamp + 1), keccak256("s"));
        vm.expectRevert(AgentEscrow.InvalidParams.selector);
        escrow.createJob(seller, 0, uint64(block.timestamp + 1), keccak256("s"));
        vm.expectRevert(AgentEscrow.InvalidParams.selector);
        escrow.createJob(seller, AMOUNT, uint64(block.timestamp), keccak256("s"));
        vm.stopPrank();
    }
}
