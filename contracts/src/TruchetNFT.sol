// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Metadata is IERC721 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

interface IERC721TokenReceiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title TruchetNFT — Collaborative hex grid of Truchet tiles
/// @notice Each token represents a tile placed on a toroidal 512×512 hex grid (even-q offset).
///         Tiles must be adjacent to at least one existing tile. Edge point counts on
///         shared edges must match. Each (family, catalanIndex) pair is unique.
///
///         Grid wraps at boundaries (torus topology). Max 262,144 tiles.
///         Token ID = packed grid coordinate: (uint256(q) << 9) | uint256(r)
contract TruchetNFT is IERC721Metadata {
    // ── Constants ──────────────────────────────────────────────

    /// @dev Grid dimensions: 512×512 (9-bit coordinates).
    uint16 public constant GRID_SIZE = 512;
    uint16 internal constant MASK = 511; // GRID_SIZE - 1

    // ── Types ─────────────────────────────────────────────────

    /// @dev Tile data stored per grid cell.
    ///      Family = (ka, kb, kc) — EP counts for edge pairs (0,3), (1,4), (2,5).
    struct Tile {
        uint8 ka;
        uint8 kb;
        uint8 kc;
        bool polarity;
        uint128 catalanIndex;
    }

    // ── Storage ───────────────────────────────────────────────

    string public name;
    string public symbol;
    address public owner;
    address public gate;
    uint256 public totalSupply;

    // ERC-721 state
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _tokenApprovals;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    // Grid state: packed (q,r) → tile data
    mapping(uint256 => Tile) internal _grid;

    // Family uniqueness: packed (ka, kb, kc, catalanIndex) → placed
    mapping(uint256 => bool) internal _familyCatalanUsed;

    // ── Events ────────────────────────────────────────────────

    /// @dev Emitted on every tile placement (seed or gate). Contains all data
    ///      the off-chain solver needs — no follow-up getTile() call required.
    event TilePlaced(
        uint16 indexed q,
        uint16 indexed r,
        address indexed owner,
        uint8 ka, uint8 kb, uint8 kc,
        bool polarity,
        uint128 catalanIndex
    );

    // ── Errors ────────────────────────────────────────────────

    error ZeroAddress();
    error TokenNotFound(uint256 tokenId);
    error NotAuthorized(address caller, uint256 tokenId);
    error UnsafeRecipient(address to);
    error NotOwner();
    error CellOccupied(uint16 q, uint16 r);
    error NotAdjacent(uint16 q, uint16 r);
    error EdgeMismatch(uint16 q, uint16 r, uint8 edge, uint8 required, uint8 provided);
    error CatalanIndexUsed(uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex);
    error InvalidEpCount();
    error EpSumDeltaTooLarge(uint16 q, uint16 r, uint16 ourSum, uint16 neighborSum);
    error PolarityConflict(uint16 q, uint16 r, uint8 edge);
    error PolarityDeadCell(uint16 q, uint16 r);
    error NotGate();

    // ── Modifiers ─────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ── Constructor ───────────────────────────────────────────

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function setGate(address gate_) external onlyOwner {
        gate = gate_;
    }

    // ── Token ID = packed grid coordinate ─────────────────────

    function tokenIdOf(uint16 q, uint16 r) public pure returns (uint256) {
        return (uint256(q & MASK) << 9) | uint256(r & MASK);
    }

    function tokenCoords(uint256 tokenId) public pure returns (uint16 q, uint16 r) {
        q = uint16((tokenId >> 9) & uint256(MASK));
        r = uint16(tokenId & uint256(MASK));
    }

    // ── Hex grid: even-q offset neighbors (toroidal) ─────────
    //
    //  Edge 0 = right        Edge 3 = left         (both ka)
    //  Edge 1 = bottom-right Edge 4 = top-left     (both kb)
    //  Edge 2 = bottom-left  Edge 5 = top-right    (both kc)
    //
    //  Neighbor across edge i has facing edge (i+3)%6.
    //  Coordinates wrap mod GRID_SIZE (torus topology).

    /// @dev Returns the neighbor coordinate for cell (q,r) across the given edge.
    ///      Wraps mod GRID_SIZE for torus topology. Arithmetic done in uint32
    ///      to avoid underflow, then masked back to 9 bits.
    function _neighbor(uint16 q, uint16 r, uint8 edge) internal pure returns (uint16 nq, uint16 nr) {
        bool evenCol = (q & 1) == 0;
        // Widen to uint32 so (0 - 1) = 0xFFFFFFFF, not an underflow panic
        uint32 wq = uint32(q);
        uint32 wr = uint32(r);
        uint32 m = uint32(MASK);

        // Use + MASK instead of - 1 to avoid underflow: (x + 511) & 511 == (x - 1) mod 512
        uint32 wnq;
        uint32 wnr;
        if (edge == 0) {
            wnq = (wq + 1) & m;
            wnr = evenCol ? wr : (wr + 1) & m;
        } else if (edge == 1) {
            wnq = wq;
            wnr = (wr + 1) & m;
        } else if (edge == 2) {
            wnq = (wq + m) & m;
            wnr = evenCol ? wr : (wr + 1) & m;
        } else if (edge == 3) {
            wnq = (wq + m) & m;
            wnr = evenCol ? (wr + m) & m : wr;
        } else if (edge == 4) {
            wnq = wq;
            wnr = (wr + m) & m;
        } else {
            // edge == 5
            wnq = (wq + 1) & m;
            wnr = evenCol ? (wr + m) & m : wr;
        }
        nq = uint16(wnq);
        nr = uint16(wnr);
    }

    /// @dev Packed grid cell key — same layout as tokenId.
    function _cellKey(uint16 q, uint16 r) internal pure returns (uint256) {
        return (uint256(q & MASK) << 9) | uint256(r & MASK);
    }

    /// @dev Returns the EP count for a given edge (0–5) of a tile.
    ///      Edges 0,3 → ka; edges 1,4 → kb; edges 2,5 → kc.
    function _edgeEpCount(Tile memory tile, uint8 edge) internal pure returns (uint8) {
        uint8 idx = edge % 3;
        if (idx == 0) return tile.ka;
        if (idx == 1) return tile.kb;
        return tile.kc;
    }

    /// @dev Packed family uniqueness key (19 bytes, fits in uint256).
    function _familyKey(uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) internal pure returns (uint256) {
        return uint256(catalanIndex) | (uint256(kc) << 128) | (uint256(kb) << 136) | (uint256(ka) << 144);
    }

    // ── Tile Placement ────────────────────────────────────────

    /// @notice Place a tile at (q, r) and mint the NFT to `to`.
    ///         Owner-only: used to seed the initial grid.
    function seedTile(address to, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, bool polarity, uint128 catalanIndex)
        external
        onlyOwner
    {
        _seedTile(to, q, r, ka, kb, kc, polarity, catalanIndex);
    }

    /// @notice Batch-seed multiple tiles in a single transaction.
    ///         Owner-only. Skips neighbor validation — caller is trusted.
    function seedTiles(
        address to,
        uint16[] calldata qs,
        uint16[] calldata rs,
        uint8[] calldata kas,
        uint8[] calldata kbs,
        uint8[] calldata kcs,
        bool[] calldata polarities,
        uint128[] calldata catalanIndexes
    ) external onlyOwner {
        uint256 n = qs.length;
        for (uint256 i = 0; i < n; i++) {
            _seedTile(to, qs[i], rs[i], kas[i], kbs[i], kcs[i], polarities[i], catalanIndexes[i]);
        }
    }

    /// @dev Trusted seed: skips neighbor/polarity validation (owner-only callers).
    ///      Only checks cell not occupied and family+catalan uniqueness.
    function _seedTile(
        address to,
        uint16 q,
        uint16 r,
        uint8 ka,
        uint8 kb,
        uint8 kc,
        bool polarity,
        uint128 catalanIndex
    ) internal {
        if (to == address(0)) revert ZeroAddress();
        if (ka == 0 && kb == 0 && kc == 0) revert InvalidEpCount();

        q &= MASK;
        r &= MASK;

        uint256 cell = _cellKey(q, r);
        if (_grid[cell].ka != 0 || _grid[cell].kb != 0 || _grid[cell].kc != 0) {
            revert CellOccupied(q, r);
        }

        uint256 fKey = _familyKey(ka, kb, kc, catalanIndex);
        if (_familyCatalanUsed[fKey]) revert CatalanIndexUsed(ka, kb, kc, catalanIndex);
        _familyCatalanUsed[fKey] = true;

        uint256 tokenId = tokenIdOf(q, r);

        _grid[cell] = Tile(ka, kb, kc, polarity, catalanIndex);
        _balances[to]++;
        _owners[tokenId] = to;
        totalSupply++;

        emit Transfer(address(0), to, tokenId);
        emit TilePlaced(q, r, to, ka, kb, kc, polarity, catalanIndex);
    }

    /// @notice Place a tile at (q, r) and mint the NFT to `to`.
    ///         Only callable by the gate contract. Must be adjacent to an existing tile.
    function placeTile(address to, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) external {
        if (msg.sender != gate) revert NotGate();
        _placeTile(to, q, r, ka, kb, kc, catalanIndex, true);
    }

    /// @dev Check all 6 neighbors. Returns whether at least one neighbor exists
    ///      and the computed polarity for this tile. Reverts on edge EP mismatch,
    ///      EP sum delta > 2, polarity conflict, or dead-cell lookahead failure.
    function _checkNeighbors(uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc)
        internal view returns (bool hasNeighbor, bool polarity)
    {
        uint8[3] memory eps = [ka, kb, kc];
        uint16 ourSum = uint16(ka) + uint16(kb) + uint16(kc);
        bool polaritySet = false;

        for (uint8 edge = 0; edge < 6; edge++) {
            (uint16 nq, uint16 nr) = _neighbor(q, r, edge);
            Tile memory nb = _grid[_cellKey(nq, nr)];
            if (nb.ka == 0 && nb.kb == 0 && nb.kc == 0) continue;

            hasNeighbor = true;

            uint8 neighborEp = _edgeEpCount(nb, (edge + 3) % 6);
            uint8 ourEp = eps[edge % 3];
            if (ourEp != neighborEp) {
                revert EdgeMismatch(q, r, edge, neighborEp, ourEp);
            }

            // EP half-sum can change by at most ±2 per step
            uint16 nbSum = uint16(nb.ka) + uint16(nb.kb) + uint16(nb.kc);
            uint16 diff = ourSum > nbSum ? ourSum - nbSum : nbSum - ourSum;
            if (diff > 2) {
                revert EpSumDeltaTooLarge(q, r, ourSum, nbSum);
            }

            // Derive polarity from neighbor
            bool requiredPol = (ourEp % 2 == 0) ? nb.polarity : !nb.polarity;
            if (!polaritySet) {
                polarity = requiredPol;
                polaritySet = true;
            } else if (polarity != requiredPol) {
                revert PolarityConflict(q, r, edge);
            }
        }

        // Default polarity for seed tile (no neighbors)
        if (!polaritySet) {
            polarity = true;
        }

        // Lookahead: check that each empty neighbor won't become unplaceable
        _checkLookahead(q, r, eps, polarity);
    }

    /// @dev For each empty neighbor E of (q,r), verify that all of E's placed
    ///      neighbors (including the tile about to be placed at (q,r)) agree
    ///      on E's required polarity.
    function _checkLookahead(uint16 q, uint16 r, uint8[3] memory eps, bool tilePol) internal view {
        for (uint8 edge = 0; edge < 6; edge++) {
            (uint16 eq, uint16 er) = _neighbor(q, r, edge);
            // Skip if E is already occupied
            {
                Tile memory existing = _grid[_cellKey(eq, er)];
                if (existing.ka != 0 || existing.kb != 0 || existing.kc != 0) continue;
            }

            // E is empty — compute what polarity it would need
            // Constraint from the tile we're about to place
            uint8 sharedEpFromUs = eps[edge % 3];
            bool ePol = (sharedEpFromUs % 2 == 0) ? tilePol : !tilePol;
            bool ePolSet = true;

            // Check all 6 neighbors of E
            for (uint8 eEdge = 0; eEdge < 6; eEdge++) {
                (uint16 enq, uint16 enr) = _neighbor(eq, er, eEdge);
                // Skip if this neighbor is the tile being placed (already handled)
                if (enq == q && enr == r) continue;

                Tile memory enb = _grid[_cellKey(enq, enr)];
                if (enb.ka == 0 && enb.kb == 0 && enb.kc == 0) continue;

                uint8 sharedEp = _edgeEpCount(enb, (eEdge + 3) % 6);
                bool need = (sharedEp % 2 == 0) ? enb.polarity : !enb.polarity;

                if (ePolSet && ePol != need) {
                    revert PolarityDeadCell(eq, er);
                }
                ePol = need;
                ePolSet = true;
            }
        }
    }

    function _placeTile(
        address to,
        uint16 q,
        uint16 r,
        uint8 ka,
        uint8 kb,
        uint8 kc,
        uint128 catalanIndex,
        bool requireAdjacent
    ) internal {
        if (to == address(0)) revert ZeroAddress();
        if (ka == 0 && kb == 0 && kc == 0) revert InvalidEpCount();

        // Mask coordinates to grid bounds
        q &= MASK;
        r &= MASK;

        uint256 cell = _cellKey(q, r);
        if (_grid[cell].ka != 0 || _grid[cell].kb != 0 || _grid[cell].kc != 0) {
            revert CellOccupied(q, r);
        }

        (bool hasNeighbor, bool polarity) = _checkNeighbors(q, r, ka, kb, kc);
        if (requireAdjacent && !hasNeighbor) {
            revert NotAdjacent(q, r);
        }

        // Family+catalan uniqueness
        uint256 fKey = _familyKey(ka, kb, kc, catalanIndex);
        if (_familyCatalanUsed[fKey]) revert CatalanIndexUsed(ka, kb, kc, catalanIndex);
        _familyCatalanUsed[fKey] = true;

        // Token ID = packed (q, r)
        uint256 tokenId = tokenIdOf(q, r);

        _grid[cell] = Tile(ka, kb, kc, polarity, catalanIndex);
        _balances[to]++;
        _owners[tokenId] = to;
        totalSupply++;

        emit Transfer(address(0), to, tokenId);
        emit TilePlaced(q, r, to, ka, kb, kc, polarity, catalanIndex);
    }

    // ── Grid Queries ──────────────────────────────────────────

    /// @notice Returns tile data and owner at grid position (q, r).
    function getTile(uint16 q, uint16 r)
        external
        view
        returns (uint8 ka, uint8 kb, uint8 kc, bool polarity, uint128 catalanIndex, address tileOwner)
    {
        uint256 cell = _cellKey(q, r);
        Tile memory t = _grid[cell];
        ka = t.ka;
        kb = t.kb;
        kc = t.kc;
        polarity = t.polarity;
        catalanIndex = t.catalanIndex;
        tileOwner = _owners[cell];
    }

    // ── ERC-165 ───────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }

    // ── ERC-721 Queries ───────────────────────────────────────

    function balanceOf(address addr) public view returns (uint256) {
        if (addr == address(0)) revert ZeroAddress();
        return _balances[addr];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenNotFound(tokenId);
        return tokenOwner;
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (_owners[tokenId] == address(0)) revert TokenNotFound(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address addr, address operator) public view returns (bool) {
        return _operatorApprovals[addr][operator];
    }

    // ── ERC-721 Metadata ──────────────────────────────────────

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenNotFound(tokenId);
        (uint16 q, uint16 r) = tokenCoords(tokenId);
        return string.concat(
            "https://tiles.truchet.space/",
            _toString(uint256(q)), "-", _toString(uint256(r)),
            ".json"
        );
    }

    // ── Approvals ─────────────────────────────────────────────

    function approve(address to, uint256 tokenId) public {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !isApprovedForAll(tokenOwner, msg.sender)) {
            revert NotAuthorized(msg.sender, tokenId);
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ── Transfers ─────────────────────────────────────────────

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddress();
        address tokenOwner = ownerOf(tokenId);
        if (from != tokenOwner) revert NotAuthorized(from, tokenId);
        if (!_isApprovedOrOwner(msg.sender, tokenId, tokenOwner)) {
            revert NotAuthorized(msg.sender, tokenId);
        }
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(msg.sender, from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) public {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(msg.sender, from, to, tokenId, data);
    }

    // ── Internals ─────────────────────────────────────────────

    function _isApprovedOrOwner(address spender, uint256 tokenId, address tokenOwner)
        internal
        view
        returns (bool)
    {
        return spender == tokenOwner || _tokenApprovals[tokenId] == spender
            || _operatorApprovals[tokenOwner][spender];
    }

    function _checkOnERC721Received(address operator, address from, address to, uint256 tokenId, bytes memory data)
        internal
    {
        if (to.code.length > 0) {
            bytes4 retval = IERC721TokenReceiver(to).onERC721Received(operator, from, tokenId, data);
            if (retval != IERC721TokenReceiver.onERC721Received.selector) {
                revert UnsafeRecipient(to);
            }
        }
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        delete _tokenApprovals[tokenId];

        emit Transfer(from, to, tokenId);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
