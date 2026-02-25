# HodlAI x Flap Vault Integration Plan

## 1. 合约 (Smart Contracts)

### Interface

```solidity
// =========================================================
// The AI Oracle Interface (Node to Vault Communication)
// =========================================================
/**
 * @title IHoldAIProvider
 * @dev The core interface for the HodlAI Oracle Provider.
 *
 * Implementation Details:
 * 1. The `reason` function is payable. It must verify `msg.value >= getModelFee(model)`.
 *    If sufficient, the BNB fee is immediately routed to the HodlAI Treasury.
 * 2. It increments an internal `_requestId` counter and stores the request details 
 *    (requester address, model, and pending status) in a mapping for verification.
 * 3. It immediately emits the `ReasoningRequested` event containing all the payload.
 * 4. The off-chain Node listens to this event, queries the LLM API, and calls back
 *    to `fulfillReason` on the original Vault requester using the stored `requestId`.
 */
interface IHoldAIProvider {
    /**
     * @dev Emitted when a Vault requests an AI reasoning task.
     * The off-chain oracle node listens to this event to trigger the LLM.
     */
    event HoldAI_ReasoningRequested(
        uint256 indexed requestId,
        address indexed requester,
        string model,
        string systemPrompt,
        string stateString,
        string[] actionSet
    );

    /**
     * @dev Emitted when the Oracle successfully fulfills a request back to the Vault.
     */
    event HoldAI_ReasoningFulfilled(
        uint256 indexed requestId,
        address indexed requester,
        string resultAction,
        string reasoningIpfsCid
    );

    /**
     * @dev Flap Vault Requests AI reasoning.
     * Must pay the required BNB fee with the transaction.
     * 
     * String Length Constraints (to prevent gas bloat/griefing):
     * - `model`: Max 64 bytes.
     * - `systemPrompt`: Max 1024 bytes.
     * - `stateString`: Max 2048 bytes.
     * - `actionSet`: Max 10 items, each max 64 bytes.
     * These limits can be updated via administrative functions.
     */
    function reason(
        string calldata model,
        string calldata systemPrompt,
        string calldata stateString,
        string[] calldata actionSet
    ) external payable returns (uint256 requestId);

    /**
     * @dev Fetches current fee required for a specific AI model.
     */
    function getModelFee(string calldata model) external view returns (uint256);

    /**
     * @dev Called by the HodlAI off-chain Oracle Node (with ORACLE_ROLE) 
     *      to fulfill the reasoning result and route it back to the Vault.
     */
    function fulfillNodeReasoning(
        uint256 requestId, 
        string calldata resultAction, 
        string calldata reasoningIpfsCid
    ) external;

    /**
     * @dev Returns the stored metadata for a given request.
     * Note: String payloads are NOT stored in contract state (emitted in events only). 
     * Only the requester address, model name, and fulfillment status are tracked.
     *
     * @return requester   The Vault address that initiated the request.
     * @return model       The requested AI model.
     * @return isFulfilled True if the Node has already fulfilled this request.
     */
    function getRequestInfo(uint256 requestId) external view returns (
        address requester,
        string memory model,
        bool isFulfilled
    );

    // =========================================================
    // Administrative Config Methods (DEFAULT_ADMIN_ROLE only)
    // =========================================================

    /**
     * @dev Updates length constraints for the `reason()` inputs.
     */
    function setStringLimits(
        uint256 maxModelLen,
        uint256 maxPromptLen,
        uint256 maxStateLen,
        uint256 maxActionItems,
        uint256 maxActionLen
    ) external;

    /**
     * @dev Sets the minimum BNB fee required for a specific AI model.
     */
    function setModelFee(string calldata model, uint256 feeWei) external;
}

// =========================================================
// The Vault Callback Interface (Oracle to Vault Fulfillment)
// =========================================================
abstract contract HoldAIEnabledVaultBase is VaultBaseV2 {
    /**
     * @dev Oracle node calls this to fulfill the reasoning request.
     * Only the authorized Oracle Provider can call this.
     *
     * IMPORTANT GAS LIMIT:
     * The HodlAI Oracle Node will execute this callback with a strict gas limit 
     * (e.g., maximum 1,000,000 gas). Vault developers MUST ensure that their 
     * implementation of `fulfillReason` is highly optimized. Any execution 
     * exceeding this limit will revert the Oracle's transaction, dropping the callback.
     *
     * @param requestId The unique ID of the original request.
     * @param resultAction The strictly constrained string chosen by the AI (from `actionSet`).
     * @param reasoningIpfsCid (Optional) The IPFS CID containing the AI's full reasoning trace.
     */
    function fulfillReason(
        uint256 requestId, 
        string calldata resultAction, 
        string calldata reasoningIpfsCid
    ) external virtual;
}
```

## 2. 后端 (Backend)

Node.js 后端作为链下预言机桥梁，负责抓取 BSC 链上事件并对接 HodlAI API。为了保证处理的高效与解耦，后端系统设计为基于本地 SQLite 驱动的多 Worker 异步架构。

**技术栈配置:**
- **语言 (Language)**: TypeScript (保证强类型与代码可读性)
- **数据库 (Database)**: `better-sqlite3` (高性能同步 SQLite 驱动，配置加长 `timeout` 抵御并发写入时的锁表 `database is locked` 异常)
- **Web3 通信**: `viem` (现代、轻量级 EVM 客户端库)

**架构设计 (Worker 解耦与状态机):**

数据库中针对每一条推理请求 (`ReasoningRequested`) 设定生命周期中的 3 种独立状态，以此连接不同的 Worker：
- **`PENDING` (未处理)**: 刚被 Indexer 扫链发现，进入数据库等待。
- **`PROCESSED` (已处理并请求上链)**: AI Worker 已经完成大模型调用，并已经发出上链交易 (Tx 发送完毕但未确认)。
- **`FULFILLED` (已经上链)**: Indexer 扫链发现了该笔请求最终在链上成功的 `ReasoningFulfilled` 事件，彻底闭环。

**核心模块 (Core Modules):**
1. **Event Indexing Worker (独立的扫链进程/循环):** 
   - **循环机制**: 这是一个持续的轮询循环 (Polling Loop)。首先读取本地数据库中上一次同步成功到的 `lastProcessedBlock`。然后向 RPC 请求最新的 `blockNumber`，如果最新高度确实大于上次高度，才发起 `getLogs` 查询中间这段新区块（必须严控 `batch size` / `toBlock - fromBlock`，避免超过大多数免费公共 RPC 节点允许的单词查询跨度限制）。
   - **双向监听**: 同时轮询提取 `HoldAI_ReasoningRequested` (创建新记录，状态设为 `PENDING`) 和 `HoldAI_ReasoningFulfilled` (将该记录状态更新为 `FULFILLED`) 两种事件。
   - **非阻塞更新**: 扫链程序不会被缓慢的 AI 大模型推理阻塞，它只单纯负责搬运链上数据并原子写入 SQLite。
   - **关键操作**: 必须应用 **EVM 索引 Hack**（详见参考引用），利用 `viem` 的 `batch` RPC 参数并发执行 `getBlockNumber` 和 `getLogs` 以规避负载均衡缓存污染导致漏掉事件。
2. **AI Inference & Fulfillment Worker (独立的执行进程):**
   - **任务获取**: 从 SQLite 中查询所有状态为 `PENDING` 的请求。（依赖 `better-sqlite3` 设置的锁定超时机制，确保就算 Worker 和 Indexer 同时操作一张表也不易 crash）。
   - **多进程负载均衡 (并行处理)**: 为提高吞吐量，可以横向扩展多个 AI Worker 实例。默认单个 Worker 即可；若多 Worker 并发，通过对 `requestId` 采用取模算法 (如 `requestId % WORKER_COUNT === WORKER_ID`) 来确保请求被不同 Worker 隔离处理。
   - **AI 推理防越狱提示词 (System Prompt Stub)**:
     必须在拼接请求时强制追加专属的“兜底约束”提示词，确保模型输出**仅限** `actionSet` 之一。示例设计如下：
     ```markdown
     You are a purely deterministic rule engine responding to a smart contract. 
     You MUST output EXACTLY ONE text value from the following explicitly permitted `actionSet`.
     Do NOT add Markdown formatting, explanations, or any other characters.
     Permitted Action Set: [${actionSet.join(', ')}]
     ```
   - **[TODO] 内部基础设施对齐**: AI 大脑层面的底层对接（如何优雅组装 Headers，如何调用 HodlAI Router Proxy 如 API 金库 `https://api.hodlai.fun` / OpenRouter 中转）目前在代码侧处于 **`Stub`** 状态。需留下纯净的 Interface 接口 `execute_holdai_inference()`，等待后期由 **Mine** 主导去把业务实现逻辑接入现有基建。
   - **发交易与状态流转**: AI 结束思考并命中正确指令后，立刻组装调用 `IHoldAIProvider.fulfillNodeReasoning` 的链上交易。交易广播成功发送后，立即将本地数据库中该记录的状态变更为 `PROCESSED`。


## 3. 参考引用 (References)

### Flap Interfaces

The following Flap V2 Vault specification interfaces are used as the foundation for the integration.

**1. `IVaultSchemasV1.sol`** (Shared struct definitions for UI generation)
```solidity
struct FieldDescriptor {
    string name;
    string fieldType;
    string description;
    uint8 decimals;
}

struct VaultDataSchema {
    string description;
    FieldDescriptor[] fields;
    bool isArray;
}

struct ApproveAction {
    string tokenType;
    string amountFieldName;
}

struct VaultMethodSchema {
    string name;
    string description;
    FieldDescriptor[] inputs;
    FieldDescriptor[] outputs;
    ApproveAction[] approvals;
    bool isInputArray;
    bool isOutputArray;
    bool isWriteMethod;
}

struct VaultUISchema {
    string vaultType;
    string description;
    VaultMethodSchema[] methods;
}
```

**2. `VaultBase.sol`**
```solidity
abstract contract VaultBase {
    error UnsupportedChain(uint256 chainId);
    
    function _getPortal() internal view returns (address portal);
    function _getGuardian() internal view returns (address guardian);
    function description() public view virtual returns (string memory);
}
```

**3. `VaultBaseV2.sol`**
```solidity
abstract contract VaultBaseV2 is VaultBase {
    function vaultUISchema() public pure virtual returns (VaultUISchema memory schema);
}
```

### 后端 EVM RPC 负载均衡防御机制 (Backend EVM Indexing Hack)
当咱们从通过 HTTP 方式获取公有节点的链上区块日志时，为了避免多台不同状态的负载均衡服务器返回“脏的、老的区块高度”导致数据不连续或漏掉事件，**我们必须总是使用 RPC 批处理 (Batch Call)** 强行将 `getBlockNumber` 与真正的事件查询 `getLogs` 合拢在极短的一瞬间查询。最后比对返回的高度 `blockNumber` 是否切实大于上一次我们本地记录处理完的高度。

```typescript
import { createPublicClient, http, parseAbi } from 'viem'

// 将 HTTP 传输层的批处理开关打开，核心黑客手法
const transport = http('https://xxxx...', {
  batch: true
})

const client = createPublicClient({
  chain: bsc, // 使用对应的链
  transport,  // 使用已经挂上 batch=true 参数的传输对象
})

// 保证两条查询齐飞并且都在最新时刻的均衡服务器上生效
const [blockNumber, logs] = await Promise.all([
    client.getBlockNumber(),
    client.getLogs({
        events: parseAbi([ 
            // 抓取在 plan 首部定义的这行关键日志，注意为了防冲突使用了特有前缀 HoldAI_
            'event HoldAI_ReasoningRequested(uint256 indexed requestId, address indexed requester, string model, string systemPrompt, string stateString, string[] actionSet)',
            // ...
        ]),
        address: contractAddress,
        fromBlock: lastProcessedBlock,
        toBlock: latestBlock // 不要超过当前查询到相对可信度高的块高度
    })
]);
```
