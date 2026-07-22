// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IComplianceGate
/// @notice Pluggable compliance verdict source. Implementations may be backed by
///         Circle Compliance Engine screening results pushed on-chain, or by a
///         local allowlist maintained by a screener role.
interface IComplianceGate {
    /// @notice Whether `account` is currently cleared to receive settlements.
    function isAllowed(address account) external view returns (bool);
}
