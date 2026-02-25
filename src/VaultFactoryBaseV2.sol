// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct FieldDescriptor {
    string name;
    string fieldType;
    string description;
    uint256 decimals;
}

struct VaultDataSchema {
    string description;
    FieldDescriptor[] fields;
    bool isArray;
}

/// @dev Stub representing the Flap protocol VaultFactoryBaseV2 base contract.
abstract contract VaultFactoryBaseV2 {
    function vaultDataSchema() public pure virtual returns (VaultDataSchema memory);
}
