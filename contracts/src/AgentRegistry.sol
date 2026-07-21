// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title AgentRegistry
/// @notice Human-readable names for AI agents on Arc, minted as ERC-721 tokens.
///         Each name resolves to the agent's wallet plus an ERC-8004-aligned
///         agent card (service endpoint + off-chain card URI with pricing/policy).
///         Names are normalized lowercase labels, rendered as `<name>.agent.arc`.
contract AgentRegistry is ERC721 {
    struct AgentCard {
        string name; // registered label, e.g. "databot"
        address wallet; // settlement wallet (token owner at registration)
        string endpoint; // HTTP endpoint for x402-priced services
        string cardURI; // URI of the full agent card JSON (pricing, policy, reputation pointer)
        uint64 registeredAt;
    }

    mapping(uint256 => AgentCard) private _cards;
    string[] private _names;

    error NameTaken(string name);
    error NameEmpty();
    error NameInvalid(string name);
    error NotRegistered(string name);
    error NotAgentOwner();

    event AgentRegistered(string name, uint256 indexed tokenId, address indexed wallet, string endpoint, string cardURI);
    event AgentUpdated(string name, uint256 indexed tokenId, string endpoint, string cardURI);

    constructor() ERC721("AgentMesh Names", "AGENT") {}

    function tokenIdOf(string memory name) public pure returns (uint256) {
        return uint256(keccak256(bytes(name)));
    }

    /// @notice Register `name` for the caller. Name must be lowercase a-z, 0-9, or '-'.
    function register(string calldata name, string calldata endpoint, string calldata cardURI)
        external
        returns (uint256 tokenId)
    {
        bytes memory b = bytes(name);
        if (b.length == 0) revert NameEmpty();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d;
            if (!ok) revert NameInvalid(name);
        }
        tokenId = tokenIdOf(name);
        if (_exists(tokenId)) revert NameTaken(name);

        _cards[tokenId] = AgentCard({
            name: name,
            wallet: msg.sender,
            endpoint: endpoint,
            cardURI: cardURI,
            registeredAt: uint64(block.timestamp)
        });
        _names.push(name);
        _safeMint(msg.sender, tokenId);
        emit AgentRegistered(name, tokenId, msg.sender, endpoint, cardURI);
    }

    /// @notice Update the endpoint / card URI for a name the caller owns.
    function update(string calldata name, string calldata endpoint, string calldata cardURI) external {
        uint256 tokenId = tokenIdOf(name);
        if (!_exists(tokenId)) revert NotRegistered(name);
        if (ownerOf(tokenId) != msg.sender) revert NotAgentOwner();
        AgentCard storage card = _cards[tokenId];
        card.endpoint = endpoint;
        card.cardURI = cardURI;
        emit AgentUpdated(name, tokenId, endpoint, cardURI);
    }

    /// @notice Resolve a name to its current owner wallet and agent card.
    function resolve(string calldata name) external view returns (address wallet, AgentCard memory card) {
        uint256 tokenId = tokenIdOf(name);
        if (!_exists(tokenId)) revert NotRegistered(name);
        wallet = ownerOf(tokenId);
        card = _cards[tokenId];
    }

    function isRegistered(string calldata name) external view returns (bool) {
        return _exists(tokenIdOf(name));
    }

    function totalAgents() external view returns (uint256) {
        return _names.length;
    }

    /// @notice Paginated listing for discovery UIs.
    function listAgents(uint256 offset, uint256 limit) external view returns (AgentCard[] memory cards) {
        uint256 n = _names.length;
        if (offset >= n) return new AgentCard[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        cards = new AgentCard[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            cards[i - offset] = _cards[tokenIdOf(_names[i])];
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _cards[tokenId].cardURI;
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }
}
