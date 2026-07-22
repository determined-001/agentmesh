// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
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

    // ── events ──────────────────────────────────────────────────────────

    function test_EventsFullLifecycle() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(buyer);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.JobCreated(1, buyer, seller, AMOUNT, deadline, keccak256("spec"));
        uint256 jobId = escrow.createJob(seller, AMOUNT, deadline, keccak256("spec"));

        vm.prank(seller);
        vm.expectEmit(true, false, false, true);
        emit AgentEscrow.JobDelivered(jobId, keccak256("report"));
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true);
        emit AgentEscrow.JobReleased(jobId, seller, AMOUNT);
        escrow.release(jobId);
    }

    function test_EventsDisputeRefundBranch() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true);
        emit AgentEscrow.JobDisputed(jobId, buyer);
        escrow.dispute(jobId);

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit AgentEscrow.JobResolved(jobId, false);
        vm.expectEmit(true, true, false, true);
        emit AgentEscrow.JobRefunded(jobId, buyer, AMOUNT);
        escrow.resolveDispute(jobId, false);
    }

    // ── double payout ───────────────────────────────────────────────────

    function test_DoubleReleaseReverts() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));
        vm.prank(buyer);
        escrow.release(jobId);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, AgentEscrow.JobStatus.Released));
        escrow.release(jobId);
    }

    function test_RefundOfDeliveredReverts() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, AgentEscrow.JobStatus.Delivered));
        escrow.refund(jobId);
    }

    function test_DoubleRefundReverts() public {
        uint256 jobId = _createJob();
        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(jobId);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, AgentEscrow.JobStatus.Refunded));
        escrow.refund(jobId);
    }

    // ── compliance escape hatch ─────────────────────────────────────────

    function test_RefundBlocked_DeliveredSellerBlocked() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));
        vm.prank(arbiter);
        gate.setAllowed(seller, false, keccak256("sanctioned"));

        // window already closed → release reverts, refundBlocked is the only exit
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectEmit(true, true, false, true);
        emit AgentEscrow.JobRefundedCompliance(jobId, seller);
        escrow.refundBlocked(jobId); // anyone may call
        assertEq(usdc.balanceOf(buyer), 100_000_000);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentEscrow.JobStatus.Refunded));
    }

    function test_RefundBlocked_DisputedSellerBlocked() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));
        vm.prank(buyer);
        escrow.dispute(jobId);
        vm.prank(arbiter);
        gate.setAllowed(seller, false, keccak256("sanctioned"));

        escrow.refundBlocked(jobId);
        assertEq(usdc.balanceOf(buyer), 100_000_000);
    }

    function test_RefundBlocked_RevertsWhenSellerAllowed() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.SellerNotBlocked.selector, seller));
        escrow.refundBlocked(jobId);
    }

    function test_RefundBlocked_RevertsOnFundedJob() public {
        uint256 jobId = _createJob();
        vm.prank(arbiter);
        gate.setAllowed(seller, false, keccak256("sanctioned"));

        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, AgentEscrow.JobStatus.Funded));
        escrow.refundBlocked(jobId);
    }

    function test_ResolveDisputeToBlockedSellerReverts() public {
        // refund-only policy: arbiter can never force release to a blocked seller
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));
        vm.prank(buyer);
        escrow.dispute(jobId);
        vm.prank(arbiter);
        gate.setAllowed(seller, false, keccak256("sanctioned"));

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.ComplianceBlocked.selector, seller));
        escrow.resolveDispute(jobId, true);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, false); // refund path always works
        assertEq(usdc.balanceOf(buyer), 100_000_000);
    }

    // ── pause ───────────────────────────────────────────────────────────

    function test_PauseBlocksCreateJobOnly() public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("report"));

        vm.prank(arbiter);
        escrow.pause();

        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createJob(seller, AMOUNT, uint64(block.timestamp + 1 days), keccak256("spec"));

        // funds-out paths stay open while paused
        vm.prank(buyer);
        escrow.release(jobId);
        assertEq(usdc.balanceOf(seller), AMOUNT);

        vm.prank(arbiter);
        escrow.unpause();
        vm.prank(buyer);
        escrow.createJob(seller, AMOUNT, uint64(block.timestamp + 1 days), keccak256("spec"));
    }

    function test_PauseOnlyOwner() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        escrow.pause();
    }

    // ── gate swap ───────────────────────────────────────────────────────

    function test_SetGateSwapsAndEmits() public {
        ComplianceGate newGate = new ComplianceGate(arbiter);
        vm.prank(arbiter);
        vm.expectEmit(true, true, false, true);
        emit AgentEscrow.GateChanged(address(gate), address(newGate));
        escrow.setGate(IComplianceGate(address(newGate)));
        assertEq(address(escrow.gate()), address(newGate));
    }

    function test_SetGateOnlyOwnerAndNonZero() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        escrow.setGate(IComplianceGate(address(1)));

        vm.prank(arbiter);
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        escrow.setGate(IComplianceGate(address(0)));
    }

    // ── two-step ownership ──────────────────────────────────────────────

    function test_Ownable2StepTransfer() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(arbiter);
        escrow.transferOwnership(newArbiter);
        assertEq(escrow.owner(), arbiter); // not yet — pending acceptance

        vm.prank(newArbiter);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), newArbiter);
    }

    // ── fuzz ────────────────────────────────────────────────────────────

    function testFuzz_CreateDeliverRelease(uint96 amount, uint32 deadlineOffset, uint32 releaseDelay) public {
        amount = uint96(bound(amount, 1, 100_000_000));
        deadlineOffset = uint32(bound(deadlineOffset, 1, 365 days));
        releaseDelay = uint32(bound(releaseDelay, DISPUTE_WINDOW, 2 * 365 days));

        vm.prank(buyer);
        uint256 jobId = escrow.createJob(seller, amount, uint64(block.timestamp + deadlineOffset), keccak256("s"));
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));

        vm.warp(block.timestamp + releaseDelay);
        vm.prank(watcher);
        escrow.release(jobId);
        assertEq(usdc.balanceOf(seller), amount);
    }

    function testFuzz_DisputeWindowBoundary(uint32 warpOffset) public {
        uint256 jobId = _createJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        uint256 deliveredAt = block.timestamp;

        warpOffset = uint32(bound(warpOffset, 0, 2 * DISPUTE_WINDOW));
        vm.warp(deliveredAt + warpOffset);

        vm.prank(buyer);
        if (warpOffset >= DISPUTE_WINDOW) {
            vm.expectRevert(AgentEscrow.DisputeWindowClosed.selector);
            escrow.dispute(jobId);
        } else {
            escrow.dispute(jobId); // inside window: dispute always allowed
            // and third-party release must have been impossible at this instant
        }
    }
}
