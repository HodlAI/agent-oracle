// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VaultBaseV2.sol"; // 假设 Flap 的基础 Vault 合约在此
import "./HoldAIProvider.sol"; // 我们的预言机合约

/**
 * @title HoldAIEnabledVaultBase
 * @dev 任何想要接入 HodlAI 大脑的 Flap Vault 都可以继承此基础合约
 *      该合约内置了与 HoldAIProvider 的通信逻辑和标准的 AI 回调处理
 */
abstract contract HoldAIEnabledVaultBase is VaultBaseV2, IVaultCallback {
    HoldAIProvider public holdAiProvider;
    
    // AI 代理的核心人设 / 逻辑提示词
    string public systemPrompt;
    // 使用的模型 (如 "gpt-4o-mini" / "claude-3-5-sonnet")
    string public aiModel;
    
    // 记录最新一次请求的 ID 和状态
    uint256 public lastRequestId;
    string public lastAiAction;
    string public lastAiReasoningCid;

    event AiRequestSent(uint256 requestId, string model, uint256 feePaid);
    event AiActionExecuted(string action, string cid);

    /**
     * @dev 初始化绑定预言机和基础 AI 配置
     */
    function __HoldAIVault_init(
        address _provider, 
        string memory _model, 
        string memory _prompt
    ) internal {
        holdAiProvider = HoldAIProvider(payable(_provider));
        aiModel = _model;
        systemPrompt = _prompt;
    }

    /**
     * @dev 触发 AI 思考。子合约根据自己的逻辑（比如收到税满 1 BNB）调用此函数。
     */
    function triggerAiReasoning(string memory overridePrompt) public payable {
        // Vault 需要向 Provider 支付调用费
        uint256 fee = holdAiProvider.modelFees(aiModel);
        require(address(this).balance >= fee, "Vault has insufficient BNB for AI fee");

        string memory currentPrompt = bytes(overridePrompt).length > 0 ? overridePrompt : systemPrompt;
        
        // 子合约需要提供自己当前的链上状态和支持的动作集合
        string memory currentState = _buildStateString();
        string[] memory actions = _buildActionSet();

        // 携带 value 调用 provider
        lastRequestId = holdAiProvider.reason{value: fee}(
            aiModel,
            currentPrompt,
            currentState,
            actions,
            200000
        );
        
        emit AiRequestSent(lastRequestId, aiModel, fee);
    }

    /**
     * @dev 强制实现 IVaultCallback 接口。
     * 只有 Provider (Oracle Node) 能将结果写回。
     */
    function fulfillReason(
        uint256 requestId, 
        string calldata resultAction, 
        string calldata reasoningIpfsCid
    ) external override {
        require(msg.sender == address(holdAiProvider), "Only HoldAIProvider can fulfill");
        require(requestId == lastRequestId, "Mismatched request ID");

        lastAiAction = resultAction;
        lastAiReasoningCid = reasoningIpfsCid;

        // 调用子合约实际的处理逻辑
        _executeAiAction(resultAction);
        
        emit AiActionExecuted(resultAction, reasoningIpfsCid);
    }

    // =============================================================
    // 子合约 (具体的 Flap Vault) 必须实现的 Hook 函数
    // =============================================================
    
    /**
     * @dev 收集 Vault 当前的链上状态 (例如余额、代币价格、距上次操作的时间等)
     * 返回字符串格式给大模型看
     */
    function _buildStateString() internal view virtual returns (string memory);

    /**
     * @dev 定义这个 Vault 能执行的操作枚举 (如 "noop, buy_back, burn")
     */
    function _buildActionSet() internal view virtual returns (string[] memory);

    /**
     * @dev 根据大模型选择的指令，执行真实的链上状态改变
     */
    function _executeAiAction(string memory action) internal virtual;
}
