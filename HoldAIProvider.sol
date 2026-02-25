// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ---------------------------------------------------------
// The Flap.sh "Vault AI Plugin" / HodlAI Oracle Standard
// ---------------------------------------------------------
interface IVaultCallback {
    // 强制规定的回调接口：外部请求 Vault 必须实现
    function fulfillReason(uint256 requestId, string calldata resultAction, string calldata reasoningIpfsCid) external;
}

contract HoldAIProvider is Ownable, ReentrancyGuard {
    
    // 灵活处理不同算力级别的定价
    mapping(string => uint256) public modelFees;
    
    // 金库抽水目标
    address payable public hodlaiTreasury;
    
    uint256 private _requestCounter;
    
    struct Request {
        address requester;      // 请求者 (即对应的 Vault 合约)
        string model;           // 选用的 AI 模型
        bool isFulfilled;       // 状态
    }
    
    // 保存请求状态以防重复或欺诈
    mapping(uint256 => Request) public requests;

    // === 事件 ===
    // 预言机节点监听此事件发起外网大模型请求
    event ReasoningRequested(
        uint256 indexed requestId,
        address indexed requester,
        string model,
        string systemPrompt,
        string stateString,
        string actionSet
    );
    
    // 预言机节点完结交易
    event ReasoningFulfilled(
        uint256 indexed requestId,
        address indexed requester,
        string resultAction,
        string reasoningIpfsCid
    );

    error InsufficientFee(uint256 required, uint256 provided);
    error InvalidModel(string model);
    error RequestNotPending();
    error CallbackFailed();

    constructor(address payable _treasury) Ownable(msg.sender) {
        hodlaiTreasury = _treasury;
        
        // 初始定价 (示例: wei)
        modelFees["gpt-4o-mini"] = 0.005 ether;
        modelFees["claude-3-5-sonnet"] = 0.02 ether;
        modelFees["deepseek-reasoner"] = 0.01 ether;
    }

    // ---------------------------------------------------------
    // 1. 发起请求: (Vault -> Provider)
    // ---------------------------------------------------------
    function reason(
        string calldata model,
        string calldata systemPrompt,
        string calldata stateString,
        string calldata actionSet
    ) external payable nonReentrant returns (uint256 requestId) {
        uint256 fee = modelFees[model];
        if (fee == 0) revert InvalidModel(model);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        // 抽水逻辑：立刻将赚取的 BNB 打入大金库 (Treasury)
        (bool success, ) = hodlaiTreasury.call{value: msg.value}("");
        require(success, "Treasury transfer failed");

        requestId = ++_requestCounter;
        requests[requestId] = Request({
            requester: msg.sender,
            model: model,
            isFulfilled: false
        });

        // 抛出日志供 Node 后端捕捉
        emit ReasoningRequested(
            requestId,
            msg.sender,
            model,
            systemPrompt,
            stateString,
            actionSet
        );
    }

    // ---------------------------------------------------------
    // 2. 节点回调: (Node Backend -> Provider -> Vault)
    // 必须由 Owner(即我们的 Oracle Node 钱包) 触发回调
    // ---------------------------------------------------------
    function fulfillReason(
        uint256 requestId,
        string calldata resultAction,
        string calldata reasoningIpfsCid
    ) external onlyOwner nonReentrant {
        Request storage req = requests[requestId];
        if (req.requester == address(0) || req.isFulfilled) revert RequestNotPending();
        
        req.isFulfilled = true;
        
        // 安全调用请求者的回调函数
        try IVaultCallback(req.requester).fulfillReason(requestId, resultAction, reasoningIpfsCid) {
            emit ReasoningFulfilled(requestId, req.requester, resultAction, reasoningIpfsCid);
        } catch {
            // 如果对方池子逻辑崩了我们也不 revert，记为回调失败日志
            revert CallbackFailed();
        }
    }

    // ---------------------------------------------------------
    // 管理员设置
    // ---------------------------------------------------------
    function setModelFee(string calldata model, uint256 fee) external onlyOwner {
        modelFees[model] = fee;
    }
    
    function setTreasury(address payable _treasury) external onlyOwner {
        hodlaiTreasury = _treasury;
    }
}
