// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./IERC20.sol";
import {IERC3009} from "./IERC3009.sol";

/// @title MockUSDC — ERC-20 + ERC-3009 test token with real signature verification
/// @notice Matches real USDC's EIP-712 domain (name="USD Coin", version="2")
///         so that frontends can sign ReceiveWithAuthorization without changes.
contract MockUSDC is IERC20, IERC3009 {
    function name() external pure returns (string memory) { return "USD Coin"; }
    function version() external pure returns (string memory) { return "2"; }
    function symbol() external pure returns (string memory) { return "USDC"; }
    function decimals() external pure returns (uint8) { return 6; }

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(bytes32 => bool) public authorizationUsed;

    // ── EIP-712 ──

    bytes32 private immutable _DOMAIN_SEPARATOR;

    bytes32 private constant _RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USD Coin"),
            keccak256("2"),
            block.chainid,
            address(this)
        ));
    }

    // ── ERC-20 ──

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // ── Mint (test only) ──

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    // ── ERC-3009: receiveWithAuthorization ──

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
    ) external {
        require(block.timestamp > validAfter, "authorization not yet valid");
        require(block.timestamp < validBefore, "authorization expired");
        require(!authorizationUsed[nonce], "nonce used");
        require(to == msg.sender, "caller must be payee");

        bytes32 typeHash = _RECEIVE_WITH_AUTHORIZATION_TYPEHASH;
        bytes32 structHash;
        assembly {
            let p := mload(0x40)
            mstore(p, typeHash)
            mstore(add(p, 0x20), from)
            mstore(add(p, 0x40), to)
            mstore(add(p, 0x60), value)
            mstore(add(p, 0x80), validAfter)
            mstore(add(p, 0xa0), validBefore)
            mstore(add(p, 0xc0), nonce)
            structHash := keccak256(p, 0xe0)
        }
        bytes32 domSep = _DOMAIN_SEPARATOR;
        bytes32 digest;
        assembly {
            let p := mload(0x40)
            mstore(p, 0x1901000000000000000000000000000000000000000000000000000000000000)
            mstore(add(p, 0x02), domSep)
            mstore(add(p, 0x22), structHash)
            digest := keccak256(p, 0x42)
        }
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "invalid signature");

        authorizationUsed[nonce] = true;
        require(balanceOf[from] >= value, "insufficient");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /// @dev Expose domain separator for debugging.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }
}
