// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TruchetNFT} from "./TruchetNFT.sol";
import {IERC3009} from "./IERC3009.sol";
import {IERC20} from "./IERC20.sol";

/// @title TruchetGate — ETH + USDC payment gate for placing tiles
/// @notice Supports two payment paths:
///         1. ETH: user sends msg.value directly
///         2. USDC: user signs ERC-3009 receiveWithAuthorization off-chain,
///            anyone (user or relayer) can submit the tx
///         Both paths are atomic with tile placement.
contract TruchetGate {
    TruchetNFT public immutable NFT;
    IERC3009 public immutable USDC;
    address public owner;
    uint256 private priceEth;
    uint256 private priceUsdc;

    error NotOwner();
    error ZeroAddress();
    error InsufficientETH();
    error InsufficientUSDC();
    error TransferFailed();

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function _checkOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    constructor(TruchetNFT nft_, address usdc_, uint256 priceEth_, uint256 priceUsdc_) {
        NFT = nft_;
        USDC = IERC3009(usdc_);
        owner = msg.sender;
        priceEth = priceEth_;
        priceUsdc = priceUsdc_;
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function setPrices(uint256 priceEth_, uint256 priceUsdc_) external onlyOwner {
        priceEth = priceEth_;
        priceUsdc = priceUsdc_;
    }

    function getPrices() external view returns (uint256, uint256) {
        return (priceEth, priceUsdc);
    }

    /// @dev Unpack tile params from a single uint256.
    ///      Layout: [unused 72][catalanIndex 128][kc 8][kb 8][ka 8][r 16][q 16]
    function _unpack(uint256 packed) internal pure returns (
        uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex
    ) {
        q = uint16((packed) & 0xFFFF);
        r = uint16((packed >> 16) & 0xFFFF);
        ka = uint8((packed >> 32) & 0xFF);
        kb = uint8((packed >> 40) & 0xFF);
        kc = uint8((packed >> 48) & 0xFF);
        catalanIndex = uint128((packed >> 56) & type(uint128).max);
    }

    /// @dev Expand an EIP-2098 compact signature (r, vs) into (v, r, s).
    function _expandSig(uint256 sigR, uint256 sigVs) internal pure returns (
        uint8 v, bytes32 r, bytes32 s
    ) {
        r = bytes32(sigR);
        s = bytes32(sigVs & ((1 << 255) - 1));
        v = uint8(28 + (sigVs >> 255));
    }

    /// @notice Place a tile, paying with ETH.
    /// @dev msg.sender pays and receives the NFT.
    /// @param packed Tile params packed as [catalanIndex 128][kc 8][kb 8][ka 8][r 16][q 16]
    function placeTileEth(uint256 packed) external payable {
        if (msg.value < priceEth) revert InsufficientETH();
        (uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) = _unpack(packed);
        NFT.placeTile(msg.sender, q, r, ka, kb, kc, catalanIndex);
    }

    /// @notice Place a tile, paying with USDC via ERC-3009.
    /// @param from The user who signed the authorization and receives the NFT.
    ///        Can be called by anyone (relayer or user themselves).
    /// @param packed Tile params packed as [catalanIndex 128][kc 8][kb 8][ka 8][r 16][q 16]
    /// @param amount The USDC amount the user authorized (must be >= priceUsdc).
    ///        May exceed priceUsdc to cover relayer gas sponsorship fees.
    /// @param sigR EIP-2098 compact signature r value.
    /// @param sigVs EIP-2098 compact signature vs value (v parity in bit 255).
    function placeTileUsdc(
        address from,
        uint256 packed,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint256 sigR,
        uint256 sigVs
    ) external {
        if (amount < priceUsdc) revert InsufficientUSDC();
        (uint16 q, uint16 r, uint8 ka, uint8 kb, uint8 kc, uint128 catalanIndex) = _unpack(packed);
        // Nonce is SHA-256(q ‖ r ‖ ka ‖ kb ‖ kc ‖ catalanIndex), binding the
        // USDC authorization to this specific tile placement.
        bytes32 nonce = sha256(abi.encodePacked(q, r, ka, kb, kc, catalanIndex));
        (uint8 v, bytes32 authR, bytes32 authS) = _expandSig(sigR, sigVs);
        USDC.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, authR, authS);
        NFT.placeTile(from, q, r, ka, kb, kc, catalanIndex);
    }

    /// @notice Withdraw all collected ETH and USDC to the owner.
    function withdraw() external onlyOwner {
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok,) = owner.call{value: ethBal}("");
            if (!ok) revert TransferFailed();
        }
        uint256 usdcBal = IERC20(address(USDC)).balanceOf(address(this));
        if (usdcBal > 0) {
            bool ok = IERC20(address(USDC)).transfer(owner, usdcBal);
            if (!ok) revert TransferFailed();
        }
    }
}
