// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VaultFactoryBaseV2.sol"; // 假设这是Flap的 V2 Factory 基类
import "./HoldAIEnabledVaultBase.sol";

/**
 * @title HoldAIEnabledVaultFactoryBase
 * @dev 面向开发者的 Factory 基类，封装了与 HodlAI 大脑绑定的逻辑
 */
abstract contract HoldAIEnabledVaultFactoryBase is VaultFactoryBaseV2 {
    
    address public holdAiProvider;

    constructor(address _provider) {
        holdAiProvider = _provider;
    }

    /**
     * @dev Flap UI 要求的自动渲染 Schema (定义 vaultData 结构)
     * 这里默认要求输入 `model` 和 `systemPrompt`，如果子类有更多参数可以 override 或扩展
     */
    function vaultDataSchema() public pure virtual override returns (VaultDataSchema memory schema) {
        schema.description = "Creates an AI-empowered Vault connected to HodlAI network.";
        schema.fields = new FieldDescriptor[](2);
        schema.fields[0] = FieldDescriptor("model", "string", "Select AI Model (e.g., gpt-4o-mini)", 0);
        schema.fields[1] = FieldDescriptor("systemPrompt", "string", "Vault's Persona / Operating Instructions", 0);
        schema.isArray = false;
    }

    // 子类需要实现 newVault 并在内部部署/克隆特定的 Vault
    // function newVault(address taxToken, address quoteToken, bytes calldata vaultData) external virtual override returns (address vault);
}
