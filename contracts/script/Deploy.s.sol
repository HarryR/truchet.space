// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/TruchetNFT.sol";
import "../src/TruchetGate.sol";

contract Deploy is Script {
    // Mainnet USDC
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function run() external {
        uint256 priceETH = vm.envOr("PRICE_ETH", uint256(0.005 ether));
        uint256 priceUSDC = vm.envOr("PRICE_USDC", uint256(5e6));

        vm.startBroadcast();

        TruchetNFT nft = new TruchetNFT("Truchet.Space", "TRUCHET");
        TruchetGate gate = new TruchetGate(nft, USDC, priceETH, priceUSDC);
        nft.setGate(address(gate));

        vm.stopBroadcast();
    }
}
