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
    bool public seeded;
    uint256 public totalSupply;

    // ERC-721 state
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _tokenApprovals;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    // Grid state: packed (q,r) → tile data
    mapping(uint256 => Tile) internal _grid;

    // Family uniqueness bitmap: packed (ka, kb, kc, catalanIndex/256) → 256-bit word.
    // Bit (catalanIndex % 256) is set when that index is placed.
    mapping(uint256 => uint256) internal _familyCatalanBitmap;

    // Polarity bitmap: 4 bits per cell, 64 cells per uint256 word.
    // Bits [3:0] = {req_c, req_b, req_a, occupied}
    // req_x = polarity XOR (kx % 2) — the polarity this cell requires of neighbors on edge-pair x.
    mapping(uint256 => uint256) internal _polarityBitmap;

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
    error AlreadySeeded();
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

    /// @dev Packed family bitmap word key: (ka, kb, kc, catalanIndex >> 8).
    function _familyWordKey(uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) internal pure returns (uint256) {
        return (uint256(catalanIndex) >> 8) | (uint256(kc) << 120) | (uint256(kb) << 128) | (uint256(ka) << 136);
    }

    // ── Polarity Bitmap ────────────────────────────────────────

    /// @dev Read 4-bit entry from polarity bitmap (8×8 square block layout).
    function _bitmapRead(uint256 tokenId) internal view returns (uint256) {
        uint256 q = tokenId >> 9;
        uint256 r = tokenId & 0x1FF;
        uint256 wordKey = (q >> 3) << 6 | (r >> 3);
        uint256 cellIdx = ((q & 7) << 3) | (r & 7);
        return (_polarityBitmap[wordKey] >> (cellIdx << 2)) & 0xF;
    }

    /// @dev Write 4-bit entry to polarity bitmap (8×8 square block layout).
    function _bitmapWrite(uint256 tokenId, uint256 val4) internal {
        uint256 q = tokenId >> 9;
        uint256 r = tokenId & 0x1FF;
        uint256 wordKey = (q >> 3) << 6 | (r >> 3);
        uint256 shift = (((q & 7) << 3) | (r & 7)) << 2;
        _polarityBitmap[wordKey] =
            (_polarityBitmap[wordKey] & ~(uint256(0xF) << shift)) | (val4 << shift);
    }

    /// @dev Compute 4-bit bitmap value: occupied bit + 3 reserved bits.
    ///      The req_a/req_b/req_c bits are stored for potential future use but
    ///      not currently read (lookahead removed).
    function _computeBitmapVal(uint8 ka, uint8 kb, uint8 kc, bool polarity) internal pure returns (uint256) {
        uint256 p = polarity ? 1 : 0;
        return 1 | ((p ^ (uint256(ka) & 1)) << 1)
                 | ((p ^ (uint256(kb) & 1)) << 2)
                 | ((p ^ (uint256(kc) & 1)) << 3);
    }

    // ── Tile Placement ────────────────────────────────────────

    /// @notice Seed a dense width×height block of tiles. One-shot — locks permanently.
    ///         Owner-only. All data is pre-validated off-chain; no on-chain validation.
    ///         Arrays are column-major: index = col * height + row.
    ///         Polarities packed as bits in a uint256 (max 256 tiles).
    function seedTiles(
        address to,
        uint16 q0,
        uint16 r0,
        uint8 width,
        uint8 height,
        uint8[] calldata kas,
        uint8[] calldata kbs,
        uint8[] calldata kcs,
        uint128[] calldata catalanIndexes,
        uint256 polarities
    ) external onlyOwner {
        if (seeded) revert AlreadySeeded();
        if (to == address(0)) revert ZeroAddress();
        uint256 n = uint256(width) * uint256(height);

        // Polarity bitmap word cache — accumulate bits in memory, flush on word-key change.
        // Column-major iteration keeps consecutive r values together → max bitmap locality.
        uint256 cachedWordKey = type(uint256).max;
        uint256 cachedWord;

        // Family-catalan bitmap cache — accumulate bits for same-family tiles in memory.
        // Most seeds use a single family, so this avoids N-1 warm SSTOREs.
        uint256 cachedFamKey = type(uint256).max;
        uint256 cachedFamWord;

        for (uint256 col = 0; col < width; col++) {
            uint16 q = (q0 + uint16(col)) & MASK;
            for (uint256 row = 0; row < height; row++) {
                uint256 i = col * uint256(height) + row;
                uint8 ka = kas[i]; uint8 kb = kbs[i]; uint8 kc = kcs[i];
                uint16 r = (r0 + uint16(row)) & MASK;
                uint256 tokenId = (uint256(q) << 9) | uint256(r);

                // Polarity bitmap: 8×8 square block layout
                uint256 wordKey = (uint256(q) >> 3) << 6 | (uint256(r) >> 3);
                if (wordKey != cachedWordKey) {
                    if (cachedWordKey != type(uint256).max) {
                        _polarityBitmap[cachedWordKey] = cachedWord;
                    }
                    cachedWord = _polarityBitmap[wordKey];
                    cachedWordKey = wordKey;
                }

                bool pol = (polarities >> i) & 1 == 1;
                uint256 shift = (((uint256(q) & 7) << 3) | (uint256(r) & 7)) << 2;
                cachedWord = (cachedWord & ~(uint256(0xF) << shift))
                           | (_computeBitmapVal(ka, kb, kc, pol) << shift);

                // Family-catalan bitmap: load / flush on key change
                uint128 idx = catalanIndexes[i];
                uint256 fWordKey = _familyWordKey(ka, kb, kc, idx);
                if (fWordKey != cachedFamKey) {
                    if (cachedFamKey != type(uint256).max) {
                        _familyCatalanBitmap[cachedFamKey] = cachedFamWord;
                    }
                    cachedFamWord = _familyCatalanBitmap[fWordKey];
                    cachedFamKey = fWordKey;
                }
                cachedFamWord = cachedFamWord | (1 << (uint256(idx) & 255));

                _grid[_cellKey(q, r)] = Tile(ka, kb, kc, pol, idx);
                _owners[tokenId] = to;

                emit Transfer(address(0), to, tokenId);
                emit TilePlaced(q, r, to, ka, kb, kc, pol, idx);
            }
        }

        // Flush cached bitmap words
        if (cachedWordKey != type(uint256).max) {
            _polarityBitmap[cachedWordKey] = cachedWord;
        }
        if (cachedFamKey != type(uint256).max) {
            _familyCatalanBitmap[cachedFamKey] = cachedFamWord;
        }

        _balances[to] += n;
        totalSupply += n;
        seeded = true;
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
        bool polaritySet = false;

        // Track which axes (0=ka, 1=kb, 2=kc) are constrained by a neighbor.
        // Constrained axes are forced by edge matching — only free axes contribute
        // to the EP sum delta check.
        bool[3] memory axisConstrained;

        // First pass: edge matching + polarity, record constrained axes
        for (uint8 edge = 0; edge < 6; edge++) {
            (uint16 nq, uint16 nr) = _neighbor(q, r, edge);
            uint256 nKey = _cellKey(nq, nr);

            if (_bitmapRead(nKey) & 1 == 0) continue;

            hasNeighbor = true;

            Tile memory nb = _grid[nKey];

            uint8 neighborEp = _edgeEpCount(nb, (edge + 3) % 6);
            uint8 ourEp = eps[edge % 3];
            if (ourEp != neighborEp) {
                revert EdgeMismatch(q, r, edge, neighborEp, ourEp);
            }

            axisConstrained[edge % 3] = true;

            // Derive polarity from neighbor via arc color matching.
            //
            // For two hex tiles sharing edge E (tile A) / edge E'=(E+3)%6 (tile B),
            // the color at each shared corner must agree. Corner between edges i-1
            // and i has nesting depth ≡ ∑EPs(0..i-1) (mod 2), which is matching-
            // independent for non-crossing matchings. Equating colors gives:
            //
            //   flipFactor(E) = ∑EPs_A(0..E-1) + ∑EPs_B(0..E') (mod 2)
            //
            // Expanded per edge (A = new tile, B = neighbor):
            //   E=0: nb.kb + nb.kc      E=3: ka + kb + kc + nb.ka
            //   E=1: ka + nb.kc         E=4: kb + kc + nb.ka + nb.kb
            //   E=2: ka + kb            E=5: kc + nb.ka + nb.kb + nb.kc
            uint256 flipFactor;
            if (edge == 0) {
                flipFactor = (uint256(nb.kb) + uint256(nb.kc)) & 1;
            } else if (edge == 1) {
                flipFactor = (uint256(ka) + uint256(nb.kc)) & 1;
            } else if (edge == 2) {
                flipFactor = (uint256(ka) + uint256(kb)) & 1;
            } else if (edge == 3) {
                flipFactor = (uint256(ka) + uint256(kb) + uint256(kc) + uint256(nb.ka)) & 1;
            } else if (edge == 4) {
                flipFactor = (uint256(kb) + uint256(kc) + uint256(nb.ka) + uint256(nb.kb)) & 1;
            } else {
                flipFactor = (uint256(kc) + uint256(nb.ka) + uint256(nb.kb) + uint256(nb.kc)) & 1;
            }
            bool requiredPol = (flipFactor == 0) ? nb.polarity : !nb.polarity;
            if (!polaritySet) {
                polarity = requiredPol;
                polaritySet = true;
            } else if (polarity != requiredPol) {
                revert PolarityConflict(q, r, edge);
            }
        }

        // Second pass: EP sum delta check — only the free (unconstrained) portion
        // of our sum is checked against each neighbor's free portion.
        // This allows forced edge-matched tiles to always be placeable, while
        // still limiting how fast the user can grow EPs on free edges.
        if (hasNeighbor) {
            uint16 ourFreeSum;
            for (uint8 i = 0; i < 3; i++) {
                if (!axisConstrained[i]) ourFreeSum += eps[i];
            }
            for (uint8 edge = 0; edge < 6; edge++) {
                (uint16 nq, uint16 nr) = _neighbor(q, r, edge);
                uint256 nKey = _cellKey(nq, nr);
                if (_bitmapRead(nKey) & 1 == 0) continue;

                Tile memory nb = _grid[nKey];
                uint16 nbFreeSum;
                uint8[3] memory nbEps = [nb.ka, nb.kb, nb.kc];
                for (uint8 i = 0; i < 3; i++) {
                    if (!axisConstrained[i]) nbFreeSum += nbEps[i];
                }

                uint16 diff = ourFreeSum > nbFreeSum ? ourFreeSum - nbFreeSum : nbFreeSum - ourFreeSum;
                if (diff > 2) {
                    revert EpSumDeltaTooLarge(q, r, ourFreeSum, nbFreeSum);
                }
            }
        }

        // Default polarity for seed tile (no neighbors)
        if (!polaritySet) {
            polarity = true;
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

        // Token ID = packed (q, r)
        uint256 tokenId = tokenIdOf(q, r);
        if (_bitmapRead(tokenId) & 1 != 0) revert CellOccupied(q, r);

        (bool hasNeighbor, bool polarity) = _checkNeighbors(q, r, ka, kb, kc);
        if (requireAdjacent && !hasNeighbor) {
            revert NotAdjacent(q, r);
        }

        // Family+catalan uniqueness (bitmap: 256 indices per word)
        uint256 fWordKey = _familyWordKey(ka, kb, kc, catalanIndex);
        uint256 fBit = 1 << (uint256(catalanIndex) & 255);
        if (_familyCatalanBitmap[fWordKey] & fBit != 0) revert CatalanIndexUsed(ka, kb, kc, catalanIndex);
        _familyCatalanBitmap[fWordKey] = _familyCatalanBitmap[fWordKey] | fBit;

        _grid[_cellKey(q, r)] = Tile(ka, kb, kc, polarity, catalanIndex);
        _bitmapWrite(tokenId, _computeBitmapVal(ka, kb, kc, polarity));
        _balances[to]++;
        _owners[tokenId] = to;
        totalSupply++;

        emit Transfer(address(0), to, tokenId);
        emit TilePlaced(q, r, to, ka, kb, kc, polarity, catalanIndex);
    }

    // ── Occupancy Bitmap Read ──────────────────────────────────

    /// @notice Batch-read occupancy bitmap (1 bit per cell, 256 cells per word).
    /// @param packed  Bits [7:0] = count N (max 24).
    ///                For i in 0..N-1: bits [8+10*i .. 17+10*i] = block index (0–1023).
    ///                Each block covers a 16×16 region (2×2 grid of 8×8 storage words).
    ///                Block index = (bq << 5) | br, where bq,br = 0..31.
    /// @return words  The N repacked occupancy words.
    function readOccupancy(uint256 packed) external view returns (uint256[] memory words) {
        uint256 n = packed & 0xFF;
        if (n > 24) n = 24;
        words = new uint256[](n);
        for (uint256 i; i < n; i++) {
            uint256 idx = (packed >> (8 + 10 * i)) & 0x3FF;
            uint256 bq = idx >> 5;
            uint256 br = idx & 31;
            uint256 packed256;
            for (uint256 sub; sub < 4; sub++) {
                uint256 sq = (bq << 1) | (sub >> 1);
                uint256 sr = (br << 1) | (sub & 1);
                uint256 src = _polarityBitmap[(sq << 6) | sr];
                uint256 bits64;
                for (uint256 c; c < 64; c++) {
                    bits64 |= ((src >> (c << 2)) & 1) << c;
                }
                packed256 |= bits64 << (sub << 6);
            }
            words[i] = packed256;
        }
    }

    // ── Grid Queries ──────────────────────────────────────────

    /// @notice Check whether a (family, catalanIndex) pair has been placed.
    function isCatalanUsed(uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) public view returns (bool) {
        uint256 fWordKey = _familyWordKey(ka, kb, kc, catalanIndex);
        return _familyCatalanBitmap[fWordKey] & (1 << (uint256(catalanIndex) & 255)) != 0;
    }

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
