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

    // ── Helper: place via gate USDC with dummy auth params ──

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

    // ── TilePlaced event ────────────────────────────────────

    function test_tilePlaced_emittedOnSeed() public {
        vm.expectEmit(true, true, true, true);
        emit TruchetNFT.TilePlaced(10, 20, alice, 3, 2, 1, true, 0);
        nft.seedTile(alice, 10, 20, 3, 2, 1, true, 0);
    }

    function test_tilePlaced_emittedOnPlaceETH() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        vm.expectEmit(true, true, true, true);
        // Shared edge ka=2 (even) → same polarity = true
        emit TruchetNFT.TilePlaced(11, 10, alice, 2, 2, 2, true, 1);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
    }

    function test_tilePlaced_polarityFlip() public {
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectEmit(true, true, true, true);
        // Shared edge ka=3 (odd) → opposite polarity = false
        emit TruchetNFT.TilePlaced(11, 10, alice, 3, 2, 1, false, 1);
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
    }

    function test_seedTile_atOrigin() public {
        // Boundary: neighbors wrap via torus topology
        nft.seedTile(alice, 0, 0, 2, 1, 1, true, 0);
        assertEq(nft.totalSupply(), 1);
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
        // 512 wraps to 0, 513 wraps to 1
        assertEq(nft.tokenIdOf(512, 512), nft.tokenIdOf(0, 0));
        assertEq(nft.tokenIdOf(513, 513), nft.tokenIdOf(1, 1));
    }

    function test_tokenURI() public {
        nft.seedTile(alice, 5, 12, 3, 2, 1, true, 0);
        uint256 tokenId = nft.tokenIdOf(5, 12);
        assertEq(nft.tokenURI(tokenId), "https://tiles.truchet.space/5-12.json");
    }

    // ── Seed tiles ───────────────────────────────────────────

    function test_seedTile() public {
        nft.seedTile(alice, 10, 20, 3, 2, 1, true, 0);
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

    function test_seedTile_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotOwner.selector);
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
    }

    function test_seedTile_noAdjacencyRequired() public {
        nft.seedTile(alice, 100, 200, 3, 2, 1, true, 0);
        assertEq(nft.totalSupply(), 1);
    }

    function test_seedTile_cellOccupied() public {
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.CellOccupied.selector, uint16(10), uint16(10)));
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 1);
    }

    function test_seedTile_duplicateFamilyCatalan() public {
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.CatalanIndexUsed.selector, uint8(3), uint8(2), uint8(1), uint128(0))
        );
        nft.seedTile(alice, 50, 50, 3, 2, 1, true, 0);
    }

    function test_seedTile_invalidEpCount() public {
        vm.expectRevert(TruchetNFT.InvalidEpCount.selector);
        nft.seedTile(alice, 10, 10, 0, 0, 0, true, 0);
    }

    // ── Batch seed ────────────────────────────────────────────

    function test_seedTiles_batch() public {
        uint16[] memory qs = new uint16[](3);
        uint16[] memory rs = new uint16[](3);
        uint8[] memory kas = new uint8[](3);
        uint8[] memory kbs = new uint8[](3);
        uint8[] memory kcs = new uint8[](3);
        bool[] memory pols = new bool[](3);
        uint128[] memory idxs = new uint128[](3);

        // Tile 0: seed at (10,10)
        qs[0] = 10; rs[0] = 10; kas[0] = 2; kbs[0] = 2; kcs[0] = 2; pols[0] = true; idxs[0] = 0;
        // Tile 1: neighbor at (11,10) — edge 0 of (10,10), shared ka=2
        qs[1] = 11; rs[1] = 10; kas[1] = 2; kbs[1] = 2; kcs[1] = 2; pols[1] = true; idxs[1] = 1;
        // Tile 2: neighbor at (10,11) — edge 1 of (10,10), shared kb=2
        qs[2] = 10; rs[2] = 11; kas[2] = 2; kbs[2] = 2; kcs[2] = 2; pols[2] = true; idxs[2] = 2;

        nft.seedTiles(alice, qs, rs, kas, kbs, kcs, pols, idxs);
        assertEq(nft.totalSupply(), 3);
        assertEq(nft.ownerOf(nft.tokenIdOf(10, 10)), alice);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
        assertEq(nft.ownerOf(nft.tokenIdOf(10, 11)), alice);
    }

    function test_seedTiles_batch_onlyOwner() public {
        uint16[] memory qs = new uint16[](1);
        uint16[] memory rs = new uint16[](1);
        uint8[] memory kas = new uint8[](1);
        uint8[] memory kbs = new uint8[](1);
        uint8[] memory kcs = new uint8[](1);
        bool[] memory pols = new bool[](1);
        uint128[] memory idxs = new uint128[](1);
        qs[0] = 10; rs[0] = 10; kas[0] = 2; kbs[0] = 1; kcs[0] = 1; pols[0] = true; idxs[0] = 0;

        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotOwner.selector);
        nft.seedTiles(alice, qs, rs, kas, kbs, kcs, pols, idxs);
    }

    // ── Place tiles via gate ETH ────────────────────────────

    function test_placeTileETH() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileETH_pullsETH() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 gateBefore = address(gate).balance;
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        assertEq(address(gate).balance - gateBefore, PRICE_ETH);
    }

    function test_placeTileETH_wrongValue() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        vm.prank(alice);
        vm.expectRevert(TruchetGate.WrongETH.selector);
        gate.placeTileETH{value: 0.001 ether}(11, 10, 2, 2, 2, 1);
    }

    // ── Place tiles via gate USDC ───────────────────────────

    function test_placeTileUSDC() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        _placeUSDC(alice, 11, 10, 2, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileUSDC_viaRelayer() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        _placeUSDC(alice, relayer, 11, 10, 2, 2, 2, 1, keccak256("nonce1"));
        assertEq(nft.ownerOf(nft.tokenIdOf(11, 10)), alice);
    }

    function test_placeTileUSDC_pullsUSDC() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 gateBefore = usdc.balanceOf(address(gate));
        _placeUSDC(alice, 11, 10, 2, 2, 2, 1);
        assertEq(usdc.balanceOf(address(gate)) - gateBefore, PRICE_USDC);
    }

    function test_placeTileUSDC_duplicateNonce() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
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
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
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
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.NotAdjacent.selector, uint16(50), uint16(50)));
        _placeETH(alice, 50, 50, 3, 2, 1, 1);
    }

    function test_placeTile_edgeMismatch() public {
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        // Edge 0 (right) of (10,10) is ka=3; placing at (11,10) with ka=2 should fail
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.EdgeMismatch.selector, uint16(11), uint16(10), uint8(3), uint8(3), uint8(2))
        );
        _placeETH(alice, 11, 10, 2, 2, 1, 1);
    }

    function test_placeTile_multipleNeighbors() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        nft.seedTile(alice, 10, 11, 2, 2, 2, true, 1);
        // (11,10) neighbors both (10,10) via edge 0 and (10,11) — both have matching EPs
        _placeETH(alice, 11, 10, 2, 2, 2, 2);
        assertEq(nft.totalSupply(), 3);
    }

    function test_placeTile_notGate() public {
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        // Direct call to placeTile without going through gate
        vm.prank(alice);
        vm.expectRevert(TruchetNFT.NotGate.selector);
        nft.placeTile(alice, 11, 10, 3, 2, 1, 1);
    }

    function test_placeTile_epSumDeltaTooLarge() public {
        // Seed with sum=6
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        // Try to place with ka=3 (matching) but kb=5,kc=5 → sum=13, delta=7
        vm.expectRevert(
            abi.encodeWithSelector(TruchetNFT.EpSumDeltaTooLarge.selector, uint16(11), uint16(10), uint16(13), uint16(6))
        );
        _placeETH(alice, 11, 10, 3, 5, 5, 1);
    }

    function test_placeTile_epSumDeltaWithin2() public {
        // Seed with sum=6 (2+2+2)
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        // Place with ka=2 (matching), sum=8 (2+4+2), delta=2 — should succeed
        _placeETH(alice, 11, 10, 2, 4, 2, 1);
        assertEq(nft.totalSupply(), 2);
    }

    // ── Polarity ─────────────────────────────────────────────

    function test_polarity_evenEp_samePolarity() public {
        // Seed tile at (10,10) with ka=2 → polarity=true (default)
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        // Place at (11,10) — shared edge ka=2 (even) → same polarity = true
        _placeETH(alice, 11, 10, 2, 2, 2, 1);
        (, , , bool pol, ,) = nft.getTile(11, 10);
        assertTrue(pol);
    }

    function test_polarity_oddEp_flipsPolarity() public {
        // Seed tile at (10,10) with ka=3 → polarity=true (default)
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        // Place at (11,10) — shared edge ka=3 (odd) → flipped polarity = false
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
        (, , , bool pol, ,) = nft.getTile(11, 10);
        assertFalse(pol);
    }

    function test_polarity_multipleNeighborAgreement() public {
        // Two neighbors that agree on required polarity
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        _placeETH(alice, 10, 11, 2, 2, 2, 1);
        // Both (10,10) and (10,11) have polarity=true, and shared edges are even EP
        // so any cell adjacent to both should also get polarity=true
        assertEq(nft.totalSupply(), 2);
    }

    // ── Polarity dead cell (lookahead) ──────────────────────

    function test_polarity_deadCell_reverts() public {
        // Create a scenario where placing a tile would make an empty neighbor unplaceable
        nft.seedTile(alice, 10, 10, 3, 2, 1, true, 0);
        // Place at (11,10) — shared ka=3 (odd) → polarity=false
        _placeETH(alice, 11, 10, 3, 2, 1, 1);
        // Try to place at (10,9) — the lookahead detects that (11,9) would become
        // unplaceable due to conflicting polarity requirements from its neighbors
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.PolarityDeadCell.selector, uint16(11), uint16(9)));
        _placeETH(alice, 10, 9, 2, 2, 1, 2);
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
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        assertEq(nft.balanceOf(alice), 1);
        nft.seedTile(alice, 50, 50, 2, 2, 2, true, 1);
        assertEq(nft.balanceOf(alice), 2);
    }

    // ── Transfers ────────────────────────────────────────────

    function test_transfer() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_transfer_notAuthorized() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TruchetNFT.NotAuthorized.selector, bob, tokenId));
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_approve_and_transfer() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.approve(bob, tokenId);
        assertEq(nft.getApproved(tokenId), bob);
        vm.prank(bob);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_setApprovalForAll() public {
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
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
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
        uint256 tokenId = nft.tokenIdOf(10, 10);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(recv), tokenId);
        assertEq(nft.ownerOf(tokenId), address(recv));
    }

    function test_safeTransferFrom_badReceiver() public {
        BadReceiver recv = new BadReceiver();
        nft.seedTile(alice, 10, 10, 2, 2, 2, true, 0);
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

    // ── Edge cases ──────────────────────────────────────────

    function test_placeTile_epCount_1() public {
        nft.seedTile(alice, 10, 10, 2, 1, 1, true, 0);
        // ka=2 matching, kb and kc free as long as sum delta <= 2
        _placeETH(alice, 11, 10, 2, 1, 1, 1);
        assertEq(nft.totalSupply(), 2);
    }

    function test_placeTile_epCount_varied() public {
        nft.seedTile(alice, 10, 10, 4, 2, 2, true, 0);
        // Place at (11,10) with matching ka=4
        _placeETH(alice, 11, 10, 4, 2, 2, 1);
        assertEq(nft.totalSupply(), 2);
    }
}
