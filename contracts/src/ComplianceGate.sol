// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IComplianceGate} from "./interfaces/IComplianceGate.sol";

/// @title ComplianceGate
/// @notice On-chain allowlist gating settlement release. Verdicts are pushed by
///         accounts holding SCREENER_ROLE — in production an off-chain screener
///         service backed by Circle Compliance Engine; in the fallback mode a
///         locally maintained allowlist.
contract ComplianceGate is AccessControl, IComplianceGate {
    bytes32 public constant SCREENER_ROLE = keccak256("SCREENER_ROLE");

    struct Verdict {
        bool allowed;
        bytes32 reasonHash; // hash of the off-chain screening report / reason
        uint64 screenedAt;
    }

    mapping(address => Verdict) public verdicts;

    event Screened(address indexed account, bool allowed, bytes32 reasonHash, address indexed screener);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCREENER_ROLE, admin);
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
    function isAllowed(address account) external view returns (bool) {
        return verdicts[account].allowed;
    }
}
