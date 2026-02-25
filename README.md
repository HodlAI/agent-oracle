# HodlAI Oracle Provider (Flap Vault Integration)

A decentralized AI Oracle architecture on BSC. External smart contracts (like Flap Vaults) request AI reasoning bounded by strict context and action sets, paying BNB fees. The HodlAI off-chain engine fulfills the request, executing the chosen action and publishing the reasoning trace to IPFS for cryptographic verifiability.

## Architecture

1. **On-Chain Trigger:** `HoldAIProvider.sol` receives a request with state string, action enum strings, and a protocol fee (BNB).
2. **Off-Chain Listener:** `oracle_node.js` catches the `ReasoningRequested` event.
3. **Execution Layer:** Node queries `api.hodlai.fun`, forcing a structured JSON output (the selected action) based on the user-provided context.
4. **Verifiability:** Node pins the full request, system prompt, thinking process, and result to IPFS (via Pinata).
5. **Callback & Fulfillment:** Node calls `fulfillReason` on `HoldAIProvider.sol`, piping the selected action and IPFS CID back onto the chain. The Provider securely routes the callback to the requesting Vault.

[Documentation extending soon...]
