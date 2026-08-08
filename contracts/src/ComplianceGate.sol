// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IComplianceGate} from "./interfaces/IComplianceGate.sol";

/// @title ComplianceGate
/// @notice On-chain allowlist gating settlement release. Verdicts are pushed by
///         accounts holding SCREENER_ROLE — in production an off-chain screener
///         service backed by Circle Compliance Engine; in the fallback mode a
///         locally maintained allowlist.
/// @dev Admin transfer is two-step and time-delayed (matching the escrow's
///      Ownable2Step), so a mistyped address cannot strand gate administration.
///      Note that `grantRole` cannot grant DEFAULT_ADMIN_ROLE under these rules:
///      use beginDefaultAdminTransfer / acceptDefaultAdminTransfer.
contract ComplianceGate is AccessControlDefaultAdminRules, IComplianceGate {
    bytes32 public constant SCREENER_ROLE = keccak256("SCREENER_ROLE");

    struct Verdict {
        bool allowed;
        bytes32 reasonHash; // hash of the off-chain screening report / reason
        uint64 screenedAt;
    }

    error ZeroAddress();

    mapping(address => Verdict) public verdicts;

    /// @notice Seconds after which an "allowed" verdict goes stale and the
    ///         account reads as not allowed until re-screened. 0 disables expiry.
    uint64 public verdictTtl;

    event Screened(address indexed account, bool allowed, bytes32 reasonHash, address indexed screener);
    event VerdictTtlSet(uint64 oldTtl, uint64 newTtl);

    /// @param adminDelay Seconds an admin handover must wait before it can be accepted.
    /// @param admin      Holds DEFAULT_ADMIN_ROLE; keep this key cold.
    /// @param screener   Holds SCREENER_ROLE — the watcher's hot key. Wiring both
    ///                   here means the deployer never holds admin, so there is
    ///                   no post-deploy revoke that can be forgotten.
    constructor(uint48 adminDelay, address admin, address screener) AccessControlDefaultAdminRules(adminDelay, admin) {
        if (admin == address(0) || screener == address(0)) revert ZeroAddress();
        _grantRole(SCREENER_ROLE, screener);
    }

    /// @notice Set the verdict time-to-live (admin only). 0 = verdicts never expire.
    function setVerdictTtl(uint64 newTtl) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit VerdictTtlSet(verdictTtl, newTtl);
        verdictTtl = newTtl;
    }

    /// @notice Record a screening verdict for `account`.
    function setAllowed(address account, bool allowed, bytes32 reasonHash) external onlyRole(SCREENER_ROLE) {
        verdicts[account] = Verdict({allowed: allowed, reasonHash: reasonHash, screenedAt: uint64(block.timestamp)});
        emit Screened(account, allowed, reasonHash, msg.sender);
    }

    /// @notice Batch variant for onboarding several agents at once.
    function setAllowedBatch(address[] calldata accounts, bool allowed, bytes32 reasonHash)
        external
        onlyRole(SCREENER_ROLE)
    {
        for (uint256 i = 0; i < accounts.length; i++) {
            verdicts[accounts[i]] =
                Verdict({allowed: allowed, reasonHash: reasonHash, screenedAt: uint64(block.timestamp)});
            emit Screened(accounts[i], allowed, reasonHash, msg.sender);
        }
    }

    /// @inheritdoc IComplianceGate
    /// @dev An "allowed" verdict older than `verdictTtl` reads as false —
    ///      stale screenings must not keep authorizing payouts forever.
    function isAllowed(address account) external view returns (bool) {
        Verdict storage v = verdicts[account];
        if (!v.allowed) return false;
        uint64 ttl = verdictTtl;
        if (ttl != 0 && block.timestamp > uint256(v.screenedAt) + ttl) return false;
        return true;
    }

    /// @inheritdoc IComplianceGate
    /// @dev True only for an affirmative deny that a screener actually wrote.
    ///      A never-screened account (screenedAt == 0) is unknown, not blocked,
    ///      and a stale "allowed" verdict is unknown too — it stops authorizing
    ///      payouts via {isAllowed} without ever becoming a sanction.
    function isBlocked(address account) external view returns (bool) {
        Verdict storage v = verdicts[account];
        return v.screenedAt != 0 && !v.allowed;
    }
}
