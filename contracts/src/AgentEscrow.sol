// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IComplianceGate} from "./interfaces/IComplianceGate.sol";

/// @title AgentEscrow
/// @notice USDC escrow for high-value agent-to-agent jobs on Arc.
///         Lifecycle: createJob (buyer funds) → deliver (seller submits proof)
///         → release (buyer anytime, or anyone after the dispute window)
///         with an alternate dispute → arbiter-resolution branch and a
///         deadline-based refund path. Release is gated by an IComplianceGate:
///         funds never flow to a seller that fails screening.
contract AgentEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus {
        None,
        Funded,
        Delivered,
        Disputed,
        Released,
        Refunded
    }

    struct Job {
        address buyer;
        address seller;
        uint256 amount; // USDC, 6 decimals (ERC-20 interface on Arc)
        uint64 deadline; // seller must deliver by this timestamp
        uint64 deliveredAt;
        bytes32 specHash; // hash of the job spec / intent
        bytes32 deliverableHash; // hash of the delivered artifact
        JobStatus status;
    }

    IERC20 public immutable usdc;
    IComplianceGate public immutable gate;
    uint64 public immutable disputeWindow; // seconds after delivery during which buyer may dispute

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    error InvalidParams();
    error NotBuyer();
    error NotSeller();
    error WrongStatus(JobStatus actual);
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DisputeWindowOpen();
    error DisputeWindowClosed();
    error ComplianceBlocked(address seller);

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    );
    event JobDelivered(uint256 indexed jobId, bytes32 deliverableHash);
    event JobReleased(uint256 indexed jobId, address indexed seller, uint256 amount);
    event JobDisputed(uint256 indexed jobId, address indexed buyer);
    event JobResolved(uint256 indexed jobId, bool releasedToSeller);
    event JobRefunded(uint256 indexed jobId, address indexed buyer, uint256 amount);

    constructor(IERC20 usdc_, IComplianceGate gate_, uint64 disputeWindow_, address arbiter) Ownable(arbiter) {
        usdc = usdc_;
        gate = gate_;
        disputeWindow = disputeWindow_;
    }

    /// @notice Buyer locks `amount` USDC for `seller` until delivery. Requires prior ERC-20 approval.
    function createJob(address seller, uint256 amount, uint64 deadline, bytes32 specHash)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (seller == address(0) || amount == 0 || deadline <= block.timestamp) revert InvalidParams();
        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            deadline: deadline,
            deliveredAt: 0,
            specHash: specHash,
            deliverableHash: bytes32(0),
            status: JobStatus.Funded
        });
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit JobCreated(jobId, msg.sender, seller, amount, deadline, specHash);
    }

    /// @notice Seller submits proof of delivery before the deadline.
    function deliver(uint256 jobId, bytes32 deliverableHash) external {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Funded) revert WrongStatus(job.status);
        if (msg.sender != job.seller) revert NotSeller();
        if (block.timestamp > job.deadline) revert DeadlinePassed();
        job.status = JobStatus.Delivered;
        job.deliveredAt = uint64(block.timestamp);
        job.deliverableHash = deliverableHash;
        emit JobDelivered(jobId, deliverableHash);
    }

    /// @notice Release escrowed funds to the seller. Buyer may release any time
    ///         after delivery; anyone (e.g. the watcher) may release once the
    ///         dispute window has elapsed. Seller must pass compliance screening.
    function release(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Delivered) revert WrongStatus(job.status);
        if (msg.sender != job.buyer && block.timestamp < job.deliveredAt + disputeWindow) {
            revert DisputeWindowOpen();
        }
        _payout(jobId, job, true);
    }

    /// @notice Buyer contests the delivery within the dispute window.
    function dispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Delivered) revert WrongStatus(job.status);
        if (msg.sender != job.buyer) revert NotBuyer();
        if (block.timestamp >= job.deliveredAt + disputeWindow) revert DisputeWindowClosed();
        job.status = JobStatus.Disputed;
        emit JobDisputed(jobId, msg.sender);
    }

    /// @notice Arbiter settles a disputed job either way.
    function resolveDispute(uint256 jobId, bool releaseToSeller) external onlyOwner nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Disputed) revert WrongStatus(job.status);
        emit JobResolved(jobId, releaseToSeller);
        _payout(jobId, job, releaseToSeller);
    }

    /// @notice Refund the buyer when the seller missed the deadline without delivering.
    function refund(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Funded) revert WrongStatus(job.status);
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();
        _payout(jobId, job, false);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function _payout(uint256 jobId, Job storage job, bool toSeller) private {
        if (toSeller) {
            if (!gate.isAllowed(job.seller)) revert ComplianceBlocked(job.seller);
            job.status = JobStatus.Released;
            usdc.safeTransfer(job.seller, job.amount);
            emit JobReleased(jobId, job.seller, job.amount);
        } else {
            job.status = JobStatus.Refunded;
            usdc.safeTransfer(job.buyer, job.amount);
            emit JobRefunded(jobId, job.buyer, job.amount);
        }
    }
}
