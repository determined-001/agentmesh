// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IComplianceGate
/// @notice Pluggable compliance verdict source. Implementations may be backed by
///         Circle Compliance Engine screening results pushed on-chain, or by a
///         local allowlist maintained by a screener role.
interface IComplianceGate {
    /// @notice Whether `account` is currently cleared to receive settlements.
    function isAllowed(address account) external view returns (bool);

    /// @notice Whether `account` has been screened and explicitly denied.
    /// @dev Deliberately NOT the inverse of {isAllowed}. "Not allowed" also
    ///      covers never-screened and expired-verdict accounts, which are
    ///      merely unknown, not sanctioned. Only an affirmative deny may
    ///      trigger the escrow's compliance refund — otherwise every delivered
    ///      job is cancellable by anyone during a screening gap or outage.
    function isBlocked(address account) external view returns (bool);
}
