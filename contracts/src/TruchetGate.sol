// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TruchetNFT.sol";

/// @dev Minimal ERC-3009 interface (receiveWithAuthorization only).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @dev Minimal ERC-20 for withdraw.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title TruchetGate — ETH + USDC payment gate for placing tiles
/// @notice Supports two payment paths:
///         1. ETH: user sends msg.value directly
///         2. USDC: user signs ERC-3009 receiveWithAuthorization off-chain,
///            anyone (user or relayer) can submit the tx
///         Both paths are atomic with tile placement.
contract TruchetGate {
    TruchetNFT public immutable nft;
    IERC3009 public immutable usdc;
    address public owner;
    uint256 public priceETH;
    uint256 public priceUSDC;

    error NotOwner();
    error ZeroAddress();
    error WrongETH();
    error WrongNonce();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(TruchetNFT nft_, address usdc_, uint256 priceETH_, uint256 priceUSDC_) {
        nft = nft_;
        usdc = IERC3009(usdc_);
        owner = msg.sender;
        priceETH = priceETH_;
        priceUSDC = priceUSDC_;
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function setPriceETH(uint256 price_) external onlyOwner {
        priceETH = price_;
    }

    function setPriceUSDC(uint256 price_) external onlyOwner {
        priceUSDC = price_;
    }

    /// @notice Place a tile, paying with ETH.
    /// @dev msg.sender pays and receives the NFT.
    function placeTileETH(
        uint16 q,
        uint16 r,
        uint8 ka,
        uint8 kb,
        uint8 kc,
        uint128 catalanIndex
    ) external payable {
        if (msg.value != priceETH) revert WrongETH();
        nft.placeTile(msg.sender, q, r, ka, kb, kc, catalanIndex);
    }

    /// @notice Place a tile, paying with USDC via ERC-3009.
    /// @param from The user who signed the authorization and receives the NFT.
    ///        Can be called by anyone (relayer or user themselves).
    function placeTileUSDC(
        address from,
        uint16 q,
        uint16 r,
        uint8 ka,
        uint8 kb,
        uint8 kc,
        uint128 catalanIndex,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 authR,
        bytes32 authS
    ) external {
        // Nonce must be SHA-256(q ‖ r ‖ ka ‖ kb ‖ kc ‖ catalanIndex) to bind
        // the USDC authorization to this specific tile placement.
        bytes32 expected = sha256(abi.encodePacked(q, r, ka, kb, kc, catalanIndex));
        if (nonce != expected) revert WrongNonce();
        usdc.receiveWithAuthorization(from, address(this), priceUSDC, validAfter, validBefore, nonce, v, authR, authS);
        nft.placeTile(from, q, r, ka, kb, kc, catalanIndex);
    }

    /// @notice Withdraw all collected ETH and USDC to the owner.
    function withdraw() external onlyOwner {
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok,) = owner.call{value: ethBal}("");
            if (!ok) revert TransferFailed();
        }
        uint256 usdcBal = IERC20(address(usdc)).balanceOf(address(this));
        if (usdcBal > 0) {
            bool ok = IERC20(address(usdc)).transfer(owner, usdcBal);
            if (!ok) revert TransferFailed();
        }
    }
}
