// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";

/// @dev Drives the escrow through random action sequences. Every action guards
///      its own preconditions so most calls hit a real state transition.
contract EscrowHandler is Test {
    MockUSDC public usdc;
    ComplianceGate public gate;
    AgentEscrow public escrow;
    address public arbiter;

    address[3] public buyers = [address(0xB1), address(0xB2), address(0xB3)];
    address[3] public sellers = [address(0x51), address(0x52), address(0x53)];

    uint256 public ghost_released;
    uint256 public ghost_refunded;

    constructor(MockUSDC usdc_, ComplianceGate gate_, AgentEscrow escrow_, address arbiter_) {
        usdc = usdc_;
        gate = gate_;
        escrow = escrow_;
        arbiter = arbiter_;
        for (uint256 i = 0; i < buyers.length; i++) {
            usdc.mint(buyers[i], 1_000_000_000);
            vm.prank(buyers[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    function _job(uint256 seed) internal view returns (uint256 jobId, AgentEscrow.Job memory job) {
        uint256 n = escrow.nextJobId();
        if (n == 1) return (0, job);
        jobId = (seed % (n - 1)) + 1;
        job = escrow.getJob(jobId);
    }

    function createJob(uint256 buyerSeed, uint256 sellerSeed, uint96 amount, uint32 dl) external {
        address buyer = buyers[buyerSeed % buyers.length];
        address seller = sellers[sellerSeed % sellers.length];
        amount = uint96(bound(amount, 1, 50_000_000));
        dl = uint32(bound(dl, 1 hours, 30 days));
        if (usdc.balanceOf(buyer) < amount) return;
        vm.prank(buyer);
        escrow.createJob(seller, amount, uint64(block.timestamp + dl), keccak256(abi.encode(buyerSeed)));
    }

    function deliver(uint256 seed) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0 || job.status != AgentEscrow.JobStatus.Funded) return;
        if (block.timestamp > job.deadline) return;
        vm.prank(job.seller);
        escrow.deliver(jobId, keccak256(abi.encode(seed)));
    }

    function release(uint256 seed, bool asBuyer) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0 || job.status != AgentEscrow.JobStatus.Delivered) return;
        if (!gate.isAllowed(job.seller)) return;
        if (!asBuyer && block.timestamp < uint256(job.deliveredAt) + escrow.disputeWindow()) return;
        vm.prank(asBuyer ? job.buyer : address(this));
        escrow.release(jobId);
        ghost_released += job.amount;
    }

    function dispute(uint256 seed) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0 || job.status != AgentEscrow.JobStatus.Delivered) return;
        if (block.timestamp >= uint256(job.deliveredAt) + escrow.disputeWindow()) return;
        vm.prank(job.buyer);
        escrow.dispute(jobId);
    }

    function resolve(uint256 seed, bool toSeller) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0 || job.status != AgentEscrow.JobStatus.Disputed) return;
        if (toSeller && !gate.isAllowed(job.seller)) return;
        vm.prank(arbiter);
        escrow.resolveDispute(jobId, toSeller);
        if (toSeller) ghost_released += job.amount;
        else ghost_refunded += job.amount;
    }

    function refund(uint256 seed) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0 || job.status != AgentEscrow.JobStatus.Funded) return;
        if (block.timestamp <= job.deadline) return;
        escrow.refund(jobId);
        ghost_refunded += job.amount;
    }

    function refundBlocked(uint256 seed) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0) return;
        if (job.status != AgentEscrow.JobStatus.Delivered && job.status != AgentEscrow.JobStatus.Disputed) {
            return;
        }
        // Affirmative deny only — an unscreened or stale seller is not blocked.
        if (!gate.isBlocked(job.seller)) return;
        escrow.refundBlocked(jobId);
        ghost_refunded += job.amount;
    }

    function refundUnresolved(uint256 seed) external {
        (uint256 jobId, AgentEscrow.Job memory job) = _job(seed);
        if (jobId == 0) return;
        if (job.status != AgentEscrow.JobStatus.Delivered && job.status != AgentEscrow.JobStatus.Disputed) {
            return;
        }
        if (block.timestamp <= uint256(job.deliveredAt) + escrow.resolveTimeout()) return;
        escrow.refundUnresolved(jobId);
        ghost_refunded += job.amount;
    }

    function withdraw(uint256 seed) external {
        address who = seed % 2 == 0 ? buyers[seed % buyers.length] : sellers[seed % sellers.length];
        if (escrow.owed(who) == 0) return;
        vm.prank(who);
        escrow.withdraw();
    }

    function screen(uint256 sellerSeed, bool allowed) external {
        vm.prank(arbiter);
        gate.setAllowed(sellers[sellerSeed % sellers.length], allowed, keccak256("verdict"));
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

contract EscrowInvariantTest is Test {
    MockUSDC usdc;
    ComplianceGate gate;
    AgentEscrow escrow;
    EscrowHandler handler;
    address arbiter = makeAddr("arbiter");

    function setUp() public {
        usdc = new MockUSDC();
        gate = new ComplianceGate(2 days, arbiter, arbiter);
        escrow = new AgentEscrow(IERC20(address(usdc)), IComplianceGate(address(gate)), 1 hours, 7 days, arbiter);
        handler = new EscrowHandler(usdc, gate, escrow, arbiter);

        vm.startPrank(arbiter);
        gate.setAllowed(address(0x51), true, keccak256("clean"));
        gate.setAllowed(address(0x52), true, keccak256("clean"));
        // 0x53 starts affirmatively denied — an explicit verdict, not merely
        // the absence of one, which is what refundBlocked now requires.
        gate.setAllowed(address(0x53), false, keccak256("sanctioned"));
        vm.stopPrank();

        targetContract(address(handler));
    }

    /// Escrow can never hold less than it owes, and never leaks:
    /// balance == Σ open job amounts + Σ deferred payouts, exactly.
    /// The `owed` term covers payouts that could not be pushed (a blacklisted
    /// recipient); that money stays in the contract earmarked for {withdraw}.
    function invariant_BalanceMatchesOpenJobs() public view {
        uint256 open;
        uint256 n = escrow.nextJobId();
        for (uint256 id = 1; id < n; id++) {
            AgentEscrow.Job memory job = escrow.getJob(id);
            if (
                job.status == AgentEscrow.JobStatus.Funded || job.status == AgentEscrow.JobStatus.Delivered
                    || job.status == AgentEscrow.JobStatus.Disputed
            ) open += job.amount;
        }
        uint256 deferred;
        for (uint256 i = 0; i < 3; i++) {
            deferred += escrow.owed(handler.buyers(i)) + escrow.owed(handler.sellers(i));
        }
        assertEq(usdc.balanceOf(address(escrow)), open + deferred, "escrow balance != open jobs + deferred");
    }

    /// Terminal jobs are terminal: total paid out equals ghost accounting,
    /// i.e. no job ever pays out twice.
    function invariant_NoDoublePayout() public view {
        uint256 closed;
        uint256 n = escrow.nextJobId();
        for (uint256 id = 1; id < n; id++) {
            AgentEscrow.Job memory job = escrow.getJob(id);
            if (job.status == AgentEscrow.JobStatus.Released || job.status == AgentEscrow.JobStatus.Refunded) {
                closed += job.amount;
            }
        }
        assertEq(closed, handler.ghost_released() + handler.ghost_refunded(), "payout ghost mismatch");
    }
}
