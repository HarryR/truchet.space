// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/TruchetNFT.sol";
import "../src/TruchetGate.sol";

contract Receiver is IERC721TokenReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

contract BadReceiver is IERC721TokenReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @dev Mock USDC with ERC-3009 receiveWithAuthorization.
///      Skips signature verification — just checks msg.sender == to and transfers.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public authorizationUsed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(!authorizationUsed[nonce], "nonce used");
        authorizationUsed[nonce] = true;
        require(balanceOf[from] >= value, "insufficient");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

contract TruchetNFTTest is Test {
    TruchetNFT nft;
    TruchetGate gate;
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");
    uint256 constant PRICE_ETH = 0.005 ether;
    uint256 constant PRICE_USDC = 5e6; // 5 USDC (6 decimals)

    function setUp() public {
        nft = new TruchetNFT("Truchet.Space", "TRUCHET");
        usdc = new MockUSDC();
        gate = new TruchetGate(nft, address(usdc), PRICE_ETH, PRICE_USDC);
        nft.setGate(address(gate));
        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ── Helpers ───────────────────────────────────────────────

    function _placeUSDC(address who, address submitter, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 ci, bytes32 nonce) internal {
        vm.prank(submitter);
        gate.placeTileUSDC(who, q, r, ka, kb, kc, ci, 0, type(uint256).max, nonce, 0, bytes32(0), bytes32(0));
    }

    function _placeUSDC(address who, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 ci) internal {
        _placeUSDC(who, who, q, r, ka, kb, kc, ci, keccak256(abi.encodePacked(q, r)));
    }

    function _placeETH(address who, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 ci) internal {
        vm.prank(who);
        gate.placeTileETH{value: PRICE_ETH}(q, r, ka, kb, kc, ci);
    }

    /// @dev Seed a 1×1 block (single tile).
    function _seed(address to, uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, bool pol, uint128 idx) internal {
        uint8[] memory kas = new uint8[](1); kas[0] = ka;
        uint8[] memory kbs = new uint8[](1); kbs[0] = kb;
        uint8[] memory kcs = new uint8[](1); kcs[0] = kc;
        uint128[] memory idxs = new uint128[](1); idxs[0] = idx;
        nft.seedTiles(to, q, r, 1, 1, kas, kbs, kcs, idxs, pol ? 1 : 0);
    }

    /// @dev Seed a 1×2 block (two tiles in the same column).
    function _seed2(
        address to, uint16 q, uint16 r0,
        uint8 ka0, uint8 kb0, uint8 kc0, bool pol0, uint128 idx0,
        uint8 ka1, uint8 kb1, uint8 kc1, bool pol1, uint128 idx1
    ) internal {
        uint8[] memory kas = new uint8[](2); kas[0] = ka0; kas[1] = ka1;
        uint8[] memory kbs = new uint8[](2); kbs[0] = kb0; kbs[1] = kb1;
        uint8[] memory kcs = new uint8[](2); kcs[0] = kc0; kcs[1] = kc1;
        uint128[] memory idxs = new uint128[](2); idxs[0] = idx0; idxs[1] = idx1;
        uint256 pols = (pol0 ? 1 : 0) | (pol1 ? 2 : 0);
        nft.seedTiles(to, q, r0, 1, 2, kas, kbs, kcs, idxs, pols);
    }

    // ── TilePlaced event ────────────────────────────────────

    function test_tilePlaced_emittedOnSeed() public {
        vm.expectEmit(true, true, true, true);
        emit TruchetNFT.TilePlaced(10, 20, alice, 3, 2, 1, true, 0);
        _seed(alice, 10, 20, 3, 2, 1, true, 0);
    }

    function test_tilePlaced_emittedOnPlaceETH() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        vm.expectEmit(true, true, true, true);
        emit TruchetNFT.TilePlaced(11, 10, alice, 2, 2, 2, true, 1);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
    }

    function test_tilePlaced_polarityFlip() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectEmit(true, true, true, true);
        emit TruchetNFT.TilePlaced(11, 10, alice, 3, 2, 1, false, 1);
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
    }

    // ── Seed tiles ───────────────────────────────────────────

    function test_seedTiles() public {
        _seed(alice, 10, 20, 3, 2, 1, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 20);
        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.totalSupply(), 1);

        (uint8 ka, uint8 kb, uint8 kc, bool polarity, uint128 catalanIndex, address tileOwner) = nft.getTile(10, 20);
        assertEq(ka, 3);
        assertEq(kb, 2);
        assertEq(kc, 1);
        assertTrue(polarity);
        assertEq(catalanIndex, 0);
        assertEq(tileOwner, alice);
    }

    function test_seedTiles_atOrigin() public {
        _seed(alice, 0, 0, 2, 1, 1, true, 0);
        assertEq(nft.totalSupply(), 1);
    }

    function test_seedTiles_onlyOwner() public {
        uint8[] memory kas = new uint8[](1); kas[0] = 2;
        uint8[] memory kbs = new uint8[](1); kbs[0] = 1;
        uint8[] memory kcs = new uint8[](1); kcs[0] = 1;
        uint128[] memory idxs = new uint128[](1);
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotOwner.selector);
        nft.seedTiles(alice, 10, 10, 1, 1, kas, kbs, kcs, idxs, 1);
    }

    function test_seedTiles_alreadySeeded() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        assertTrue(nft.seeded());
        // Second call reverts
        uint8[] memory kas = new uint8[](1); kas[0] = 2;
        uint8[] memory kbs = new uint8[](1); kbs[0] = 2;
        uint8[] memory kcs = new uint8[](1); kcs[0] = 2;
        uint128[] memory idxs = new uint128[](1); idxs[0] = 1;
        vm.expectRevert(TruchetNFT.AlreadySeeded.selector);
        nft.seedTiles(alice, 50, 50, 1, 1, kas, kbs, kcs, idxs, 1);
    }

    function test_seedTiles_batch() public {
        // 2×2 block at (10,10): column-major → [col0row0, col0row1, col1row0, col1row1]
        // (10,10), (10,11), (11,10), (11,11)
        uint8[] memory kas = new uint8[](4);
        uint8[] memory kbs = new uint8[](4);
        uint8[] memory kcs = new uint8[](4);
        uint128[] memory idxs = new uint128[](4);
        for (uint256 j = 0; j < 4; j++) {
            kas[j] = 2; kbs[j] = 2; kcs[j] = 2; idxs[j] = uint128(j);
        }
        // All polarities true → bits 0-3 set = 0xF
        nft.seedTiles(alice, 10, 10, 2, 2, kas, kbs, kcs, idxs, 0xF);
        assertEq(nft.totalSupply(), 4);
        assertEq(nft.ownerOf(nft.tokenIdOf(10, 10)), alice);
        assertEq(nft.ownerOf(nft.tokenIdOf(10, 11)), alice);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 11)), alice);
    }

    function test_seedTiles_batch_onlyOwner() public {
        uint8[] memory kas = new uint8[](1); kas[0] = 2;
        uint8[] memory kbs = new uint8[](1); kbs[0] = 1;
        uint8[] memory kcs = new uint8[](1); kcs[0] = 1;
        uint128[] memory idxs = new uint128[](1);
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotOwner.selector);
        nft.seedTiles(alice, 10, 10, 1, 1, kas, kbs, kcs, idxs, 1);
    }

    function test_seedTiles_polarityBits() public {
        // 1×2 block: tile 0 polarity=true, tile 1 polarity=false
        // polarities = 0b01 = 1
        _seed2(alice, 10, 10,
            2, 2, 2, true, 0,
            2, 2, 2, false, 1);
        (, , , bool pol0, ,) = nft.getTile(10, 10);
        (, , , bool pol1, ,) = nft.getTile(10, 11);
        assertTrue(pol0);
        assertFalse(pol1);
    }

    // ── Token ID ──────────────────────────────────────────────

    function test_tokenIdOf_roundtrip() public pure {
        uint16 q = 123;
        uint16 r = 456;
        uint256 tokenId = (uint256(q) << 9) | uint256(r);
        assertEq(tokenId, (123 << 9) | 456);
        (uint16 rq, uint16 rr) = (uint16(tokenId >> 9), uint16(tokenId & 511));
        assertEq(rq, q);
        assertEq(rr, r);
    }

    function test_tokenIdOf_maxValues() public view {
        uint256 tokenId = nft.tokenIdOf(511, 511);
        assertEq(tokenId, (uint256(511) << 9) | 511);
    }

    function test_tokenIdOf_wraps() public view {
        assertEq(nft.tokenIdOf(512, 512), nft.tokenIdOf(0, 0));
        assertEq(nft.tokenIdOf(513, 513), nft.tokenIdOf(1, 1));
    }

    function test_tokenURI() public {
        _seed(alice, 5, 12, 3, 2, 1, true, 0);
        uint256 tokenId = nft.tokenIdOf(5, 12);
        assertEq(nft.tokenURI(tokenId), "https://tiles.truchet.space/5-12.json");
    }

    // ── Place tiles via gate ETH ────────────────────────────

    function test_placeTileETH() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileETH_pullsETH() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 gateBefore = address(gate).balance;
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        assertEq(address(gate).balance - gateBefore, PRICE_ETH);
    }

    function test_placeTileETH_wrongValue() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        vm.prank(alice);
        vm.expectRevert(TruchetGate.WrongETH.selector);
        gate.placeTileETH{value: 0.001 ether}(11, 10, 2, 2, 2, 1);
    }

    // ── Place tiles via gate USDC ───────────────────────────

    function test_placeTileUSDC() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeUSDC(alice, 11, 10, 2, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileUSDC_viaRelayer() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeUSDC(alice, relayer, 11, 10, 2, 2, 2, 1, keccak256("nonce1"));
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileUSDC_pullsUSDC() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 gateBefore = usdc.balanceOf(address(gate));
        _placeUSDC(alice, 11, 10, 2, 2, 2, 1);
        assertEq(usdc.balanceOf(address(gate)) - gateBefore, PRICE_USDC);
    }

    function test_placeTileUSDC_duplicateNonce() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        bytes32 nonce = keccak256("nonce1");
        _placeUSDC(alice, alice, 11, 10, 2, 2, 2, 1, nonce);
        vm.expectRevert("nonce used");
        _placeUSDC(alice, alice, 10, 11, 2, 2, 2, 2, nonce);
    }

    // ── Gate admin ──────────────────────────────────────────

    function test_gate_setOwner() public {
        assertEq(gate.owner(), address(this));
        gate.setOwner(alice);
        assertEq(gate.owner(), alice);
    }

    function test_gate_setOwner_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(TruchetGate.NotOwner.selector);
        gate.setOwner(alice);
    }

    function test_gate_setPriceETH() public {
        gate.setPriceETH(0.01 ether);
        assertEq(gate.priceETH(), 0.01 ether);
    }

    function test_gate_setPriceUSDC() public {
        gate.setPriceUSDC(10e6);
        assertEq(gate.priceUSDC(), 10e6);
    }

    function test_gate_withdraw() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        _placeUSDC(alice, 10, 11, 2, 2, 2, 2);

        uint256 ethBefore = address(this).balance;
        uint256 usdcBefore = usdc.balanceOf(address(this));
        gate.withdraw();
        assertEq(address(this).balance - ethBefore, PRICE_ETH);
        assertEq(usdc.balanceOf(address(this)) - usdcBefore, PRICE_USDC);
    }

    receive() external payable {}

    // ── Tile placement constraints ──────────────────────────

    function test_placeTile_notAdjacent() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.NotAdjacent.selector, uint16(50), uint16(50)));
        _placeETH(alice, 50, 50, 3, 2, 1, 1);
    }

    function test_placeTile_edgeMismatch() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.EdgeMismatch.selector, uint16(11), uint16(10), uint8(3), uint8(3), uint8(2))
        );
        _placeETH(alice, 11, 10, 2, 2, 1, 1);
    }

    function test_placeTile_multipleNeighbors() public {
        // Seed 1×2 block: (10,10) and (10,11)
        _seed2(alice, 10, 10,
            2, 2, 2, true, 0,
            2, 2, 2, true, 1);
        // (11,10) neighbors both — both have matching EPs
        _placeETH(alice, 11, 10, 2, 2, 2, 2);
        assertEq(nft.totalSupply(), 3);
    }

    function test_placeTile_notGate() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotGate.selector);
        nft.placeTile(alice, 11, 10, 3, 2, 1, 1);
    }

    function test_placeTile_epSumDeltaTooLarge() public {
        // Seed (3,2,1) → place (3,5,5): axis 0 constrained (ka=3), free axes 1,2.
        // Our free sum = 5+5=10, neighbor free sum = 2+1=3, delta=7 > 2.
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.EpSumDeltaTooLarge.selector, uint16(11), uint16(10), uint16(10), uint16(3))
        );
        _placeETH(alice, 11, 10, 3, 5, 5, 1);
    }

    function test_placeTile_epSumDeltaWithin2() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 2, 4, 2, 1);
        assertEq(nft.totalSupply(), 2);
    }

    // ── Polarity ─────────────────────────────────────────────

    function test_polarity_evenEp_samePolarity() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        (, , , bool pol, ,) = nft.getTile(11, 10);
        assertTrue(pol);
    }

    function test_polarity_oddEp_flipsPolarity() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
        (, , , bool pol, ,) = nft.getTile(11, 10);
        assertFalse(pol);
    }

    function test_polarity_multipleNeighborAgreement() public {
        // Seed 1×2 block, then place via gate — both agree on polarity
        _seed2(alice, 10, 10,
            2, 2, 2, true, 0,
            2, 2, 2, true, 1);
        _placeETH(alice, 11, 10, 2, 2, 2, 2);
        assertEq(nft.totalSupply(), 3);
    }

    // ── Polarity: mixed-family regression tests ───────────

    function test_polarity_mixedFamily_510_1() public {
        // Seed (511,0) and (511,1) both family 2-3-2 positive.
        _seed2(alice, 511, 0,
            2, 3, 2, true, 0,
            2, 3, 2, true, 1);
        // Place (510,1) family 5-2-2. q=510 is even.
        // Edge 0 → (511,1) axis 0: our ka=5, nb ka=2 → EdgeMismatch revert.
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.EdgeMismatch.selector, uint16(510), uint16(1), uint8(0), uint8(2), uint8(5))
        );
        _placeETH(alice, 510, 1, 5, 2, 2, 2);
    }

    function test_polarity_mixedFamily_511_0() public {
        // Seed (0,0) and (0,1) both family 2-2-2 positive.
        _seed2(alice, 0, 0,
            2, 2, 2, true, 0,
            2, 2, 2, true, 1);
        // Place (511,0) family 2-3-2. q=511 is odd.
        // Edge 5 → (0,0) axis 2, col crossing, odd→even: fab_nb = (nb.ka+nb.kb)&1 = (2+2)&1 = 0 → no flip → true
        // Edge 0 → (0,1) axis 0, col crossing, odd→even: fab_nb = (nb.ka+nb.kb)&1 = (2+2)&1 = 0 → no flip → true
        // Both agree: positive polarity.
        _placeETH(alice, 511, 0, 2, 3, 2, 2);
        (, , , bool pol, ,) = nft.getTile(511, 0);
        assertTrue(pol, "(511,0) 2-3-2 next to 2-2-2 neighbors should be positive");
    }

    function test_polarity_mixedFamily_2_510() public {
        // Exact reproduction from bad-polarity.txt.
        // Seed: (0,0), (1,0), (2,0) all 2-2-2 positive.
        uint8[] memory kas = new uint8[](3);
        uint8[] memory kbs = new uint8[](3);
        uint8[] memory kcs = new uint8[](3);
        uint128[] memory idxs = new uint128[](3);
        for (uint256 i = 0; i < 3; i++) {
            kas[i] = 2; kbs[i] = 2; kcs[i] = 2; idxs[i] = uint128(i);
        }
        nft.seedTiles(alice, 0, 0, 3, 1, kas, kbs, kcs, idxs, 0x7);

        // Place tiles in order:
        _placeETH(alice, 0, 511, 2, 2, 2, 3);   // (0,511) 2-2-2 → positive
        (, , , bool p0, ,) = nft.getTile(0, 511);
        assertTrue(p0, "(0,511) should be positive");

        _placeETH(alice, 1, 511, 2, 2, 2, 4);   // (1,511) 2-2-2 → positive
        (, , , bool p1, ,) = nft.getTile(1, 511);
        assertTrue(p1, "(1,511) should be positive");

        _placeETH(alice, 2, 511, 4, 2, 2, 0);   // (2,511) 4-2-2 → positive
        (, , , bool p2, ,) = nft.getTile(2, 511);
        assertTrue(p2, "(2,511) should be positive");

        _placeETH(alice, 1, 510, 4, 2, 2, 1);   // (1,510) 4-2-2 → positive
        (, , , bool p3, ,) = nft.getTile(1, 510);
        assertTrue(p3, "(1,510) should be positive");

        _placeETH(alice, 2, 510, 5, 2, 2, 0);   // (2,510) 5-2-2 → should be NEGATIVE
        (, , , bool p4, ,) = nft.getTile(2, 510);
        assertFalse(p4, "(2,510) 5-2-2 should be negative");
    }

    function test_polarity_mixedFamily_510_2() public {
        // Seed: (511,1) and (511,2) as 2-2-2 positive.
        uint8[] memory kas = new uint8[](2);
        uint8[] memory kbs = new uint8[](2);
        uint8[] memory kcs = new uint8[](2);
        uint128[] memory idxs = new uint128[](2);
        for (uint256 i = 0; i < 2; i++) {
            kas[i] = 2; kbs[i] = 2; kcs[i] = 2; idxs[i] = uint128(i);
        }
        nft.seedTiles(alice, 511, 1, 2, 1, kas, kbs, kcs, idxs, 0x3);

        // Place (510,2) as 2-3-2 — should be negative.
        _placeETH(alice, 510, 2, 2, 3, 2, 0);
        (, , , bool pol, ,) = nft.getTile(510, 2);
        assertTrue(pol, "(510,2) 2-3-2 should be positive");
    }

    // ── Polarity (no dead-cell lookahead) ──────────────────

    function test_polarity_noLookahead_allowsPlacement() public {
        // Previously reverted with PolarityDeadCell — now allowed since
        // lookahead was removed. Dead cells may exist but aren't prevented.
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
        _placeETH(alice, 10, 9, 2, 2, 1, 2);
        assertEq(nft.totalSupply(), 3);
    }

    // ── ERC-721 basics ──────────────────────────────────────

    function test_name() public view {
        assertEq(nft.name(), "Truchet.Space");
    }

    function test_symbol() public view {
        assertEq(nft.symbol(), "TRUCHET");
    }

    function test_supportsInterface() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC-721 Metadata
    }

    function test_balanceOf() public {
        // Seed 1×2 block: 2 tiles
        _seed2(alice, 10, 10,
            2, 2, 2, true, 0,
            2, 2, 2, true, 1);
        assertEq(nft.balanceOf(alice), 2);
    }

    // ── Transfers ────────────────────────────────────────────

    function test_transfer() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_transfer_notAuthorized() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.NotAuthorized.selector, bob, tokenId));
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_approve_and_transfer() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.approve(bob, tokenId);
        assertEq(nft.getApproved(tokenId), bob);
        vm.prank(bob);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_setApprovalForAll() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.setApprovalForAll(bob, true);
        assertTrue(nft.isApprovedForAll(alice, bob));
        vm.prank(bob);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_safeTransferFrom() public {
        Receiver recv = new Receiver();
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(recv), tokenId);
        assertEq(nft.ownerOf(tokenId), address(recv));
    }

    function test_safeTransferFrom_badReceiver() public {
        BadReceiver recv = new BadReceiver();
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.UnsafeRecipient.selector, address(recv)));
        nft.safeTransferFrom(alice, address(recv), tokenId);
    }

    // ── NFT admin ───────────────────────────────────────────

    function test_setOwner() public {
        nft.setOwner(alice);
        assertEq(nft.owner(), alice);
    }

    function test_setOwner_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotOwner.selector);
        nft.setOwner(alice);
    }

    function test_setOwner_zeroAddress() public {
        vm.expectRevert(TruchetNFT.ZeroAddress.selector);
        nft.setOwner(address(0));
    }

    function test_setGate() public {
        nft.setGate(alice);
        assertEq(nft.gate(), alice);
    }

    // ── isCatalanUsed ─────────────────────────────────────────

    function test_isCatalanUsed_false() public view {
        assertFalse(nft.isCatalanUsed(2, 2, 2, 0));
    }

    function test_isCatalanUsed_afterSeed() public {
        _seed(alice, 10, 10, 3, 2, 1, true, 0);
        assertTrue(nft.isCatalanUsed(3, 2, 1, 0));
        assertFalse(nft.isCatalanUsed(3, 2, 1, 1));
    }

    function test_isCatalanUsed_afterPlace() public {
        _seed(alice, 10, 10, 2, 2, 2, true, 0);
        assertFalse(nft.isCatalanUsed(2, 2, 2, 1));
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        assertTrue(nft.isCatalanUsed(2, 2, 2, 1));
    }

    // ── readOccupancy ─────────────────────────────────────────

    function test_readOccupancy_empty() public view {
        // No tiles placed — all bits should be 0
        uint256 packed = 1; // count=1, index=0
        uint256[] memory words = nft.readOccupancy(packed);
        assertEq(words.length, 1);
        assertEq(words[0], 0);
    }

    function test_readOccupancy_singleTile() public {
        // Seed tile at (10, 20).
        // Block index = (10>>4)<<5 | (20>>4) = 0<<5 | 1 = 1
        // sub = ((10&15)>>3)<<1 | ((20&15)>>3) = 1<<1|0 = 2
        // cell = ((10&7)<<3) | (20&7) = 16|4 = 20
        // bit = (2<<6)|20 = 148
        _seed(alice, 10, 20, 3, 2, 1, true, 0);

        uint256 packed = 1 | (1 << 8); // count=1, block index=1
        uint256[] memory words = nft.readOccupancy(packed);
        assertEq(words.length, 1);
        // Bit 148 should be set
        assertTrue(words[0] & (1 << 148) != 0, "bit 148 should be set");
        // Clear bit 148, rest should be 0
        assertEq(words[0] & ~(uint256(1) << 148), 0, "no other bits should be set");
    }

    function test_readOccupancy_multipleTiles() public {
        // Seed 2x2 block at (10,10): tiles at (10,10), (10,11), (11,10), (11,11)
        uint8[] memory kas = new uint8[](4);
        uint8[] memory kbs = new uint8[](4);
        uint8[] memory kcs = new uint8[](4);
        uint128[] memory idxs = new uint128[](4);
        for (uint256 j = 0; j < 4; j++) {
            kas[j] = 2; kbs[j] = 2; kcs[j] = 2; idxs[j] = uint128(j);
        }
        nft.seedTiles(alice, 10, 10, 2, 2, kas, kbs, kcs, idxs, 0xF);

        // All 4 tiles are in block 0 (q=0..15, r=0..15):
        // (10,10): sub=3, cell=(2<<3)|2=18, bit=192+18=210
        // (10,11): sub=3, cell=(2<<3)|3=19, bit=192+19=211
        // (11,10): sub=3, cell=(3<<3)|2=26, bit=192+26=218
        // (11,11): sub=3, cell=(3<<3)|3=27, bit=192+27=219
        uint256 packed = 1 | (0 << 8); // count=1, block index=0
        uint256[] memory words = nft.readOccupancy(packed);
        assertEq(words.length, 1);

        assertTrue(words[0] & (uint256(1) << 210) != 0, "bit 210 (10,10)");
        assertTrue(words[0] & (uint256(1) << 211) != 0, "bit 211 (10,11)");
        assertTrue(words[0] & (uint256(1) << 218) != 0, "bit 218 (11,10)");
        assertTrue(words[0] & (uint256(1) << 219) != 0, "bit 219 (11,11)");
        // Clear those 4 bits, rest should be 0
        uint256 mask = (uint256(1) << 210) | (uint256(1) << 211) | (uint256(1) << 218) | (uint256(1) << 219);
        assertEq(words[0] & ~mask, 0, "no other bits");
    }

    function test_readOccupancy_clampCount() public view {
        // Count > 24 gets clamped
        uint256 packed = 30; // count=30, but clamped to 24
        uint256[] memory words = nft.readOccupancy(packed);
        assertEq(words.length, 24);
    }

    function test_readOccupancy_wrongIndex_noMatch() public {
        _seed(alice, 10, 20, 3, 2, 1, true, 0);
        // Tile is at block index 1 — query block 2, should be empty
        uint256 packed = 1 | (2 << 8); // count=1, block index=2
        uint256[] memory words = nft.readOccupancy(packed);
        assertEq(words[0], 0);
    }

    // ── Edge cases ──────────────────────────────────────────

    function test_placeTile_epCount_1() public {
        _seed(alice, 10, 10, 2, 1, 1, true, 0);
        _placeETH(alice, 11, 10, 2, 1, 1, 1);
        assertEq(nft.totalSupply(), 2);
    }

    function test_placeTile_epCount_varied() public {
        _seed(alice, 10, 10, 4, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 4, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
    }
}
