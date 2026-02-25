require('dotenv').config();
const { createPublicClient, createWalletClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { bsc } = require('viem/chains');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

// ==========================================
// 1. Configs & Setup
// ==========================================
const RPC_URL = process.env.BSC_RPC || "https://rpc.ankr.com/bsc";
let PRIVATE_KEY = process.env.ORACLE_WALLET_PK;
if (PRIVATE_KEY && !PRIVATE_KEY.startsWith("0x")) {
    PRIVATE_KEY = "0x" + PRIVATE_KEY;
}
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x987e6269c6b7ea6898221882f11ea16f87b97777"; 

const API_BASE = "https://api.hodlai.fun/v1/chat/completions";
const HODLAI_API_KEY = process.env.HODLAI_API_KEY;

const account = privateKeyToAccount(PRIVATE_KEY);

const transport = http(RPC_URL, {
  batch: true // CRITICAL: Enables EVM Batching to avoid Load Balancer desync
});

const client = createPublicClient({
  chain: bsc,
  transport,
});

const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport
});

const abi = parseAbi([
    "event ReasoningRequested(uint256 indexed requestId, address indexed requester, string model, string systemPrompt, string stateString, string[] actionSet)",
    "event ReasoningFulfilled(uint256 indexed requestId, address indexed requester, string resultAction, string reasoningIpfsCid)",
    "function fulfillNodeReasoning(uint256 requestId, string resultAction, string reasoningIpfsCid) external",
    "function getRequestInfo(uint256 requestId) external view returns (address requester, string memory model, bool isFulfilled)"
]);

// ==========================================
// 2. Database Initialization (SQLite)
// ==========================================
const dbPath = path.join(__dirname, 'oracle.db');
const db = new Database(dbPath, { timeout: 15000 }); // 15s timeout to prevent database locked errors

db.pragma('journal_mode = WAL'); // Better concurrency

// Create state machine tables
db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
        requestId TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        model TEXT NOT NULL,
        systemPrompt TEXT NOT NULL,
        stateString TEXT NOT NULL,
        actionSet TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSED', 'FULFILLED')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lastProcessedBlock TEXT NOT NULL
    );
`);

// Prepared statements
const insertRequestStmt = db.prepare(`
    INSERT OR IGNORE INTO requests (requestId, requester, model, systemPrompt, stateString, actionSet, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
`);
const updateStatusStmt = db.prepare(`UPDATE requests SET status = ?, updatedAt = ? WHERE requestId = ?`);
const getPendingStmt = db.prepare(`SELECT * FROM requests WHERE status = 'PENDING' ORDER BY createdAt ASC`);
const updateSyncBlockStmt = db.prepare(`INSERT OR REPLACE INTO sync_state (id, lastProcessedBlock) VALUES (1, ?)`);
const getSyncBlockStmt = db.prepare(`SELECT lastProcessedBlock FROM sync_state WHERE id = 1`);


// ==========================================
// 3. AI Fulfillment Worker
// ==========================================
async function processOracleRequest(row) {
    const requestId = row.requestId;
    console.log(`[ORACLE-WORKER] Processing Request #${requestId} for ${row.model} from ${row.requester}`);
    
    // Safety check on-chain before spending credits
    try {
        const [, , isFulfilled] = await client.readContract({
             address: CONTRACT_ADDRESS,
             abi,
             functionName: 'getRequestInfo',
             args: [BigInt(requestId)]
        });
        if (isFulfilled) {
             console.log(`[ORACLE-WORKER] Request #${requestId} is already fulfilled on-chain. Skipping AI call.`);
             updateStatusStmt.run('FULFILLED', Date.now(), requestId);
             return;
        }
    } catch (e) {
        // Contract might not have the getRequestInfo yet in testnets, proceed tentatively
    }

    const actionSet = JSON.parse(row.actionSet);
    const prompt = `
[SYSTEM CONTEXT]:
${row.systemPrompt}

[CURRENT CHAIN STATE]:
${row.stateString}

[AVAILABLE ACTIONS]:
${actionSet.join(", ")}

You are an on-chain autonomous brain. You MUST respond with exactly one of the actions from the [AVAILABLE ACTIONS] list based on the context and state provided.
Do NOT output anything other than the chosen action string. Do NOT output markdown.
`;

    try {
        // Enforce HodlAI API format
        const payload = {
            model: row.model || "gemini-3.1-pro-preview", // 强制默认使用 Gemini 3.1 Pro 
            messages: [{ role: "system", content: "You are a purely deterministic rule engine responding to a smart contract. You MUST output EXACTLY ONE text value from the following explicitly permitted `actionSet`. Do NOT add Markdown formatting, explanations, or any other characters." }, { role: "user", content: prompt }],
            temperature: 0.01,
            max_tokens: 50
        };

        const aiResponse = await axios.post(API_BASE, payload, {
            headers: { 'Authorization': `Bearer ${HODLAI_API_KEY}` }
        });
        
        let chosenAction = aiResponse.data.choices[0].message.content.trim();
        
        // Anti-hallucination check
        if (!actionSet.includes(chosenAction)) {
             console.warn(`[ORACLE-WORKER] Hallucination detected: '${chosenAction}'. Fallback to 'noop'`);
             chosenAction = "noop";
             if (!actionSet.includes("noop")) {
                 chosenAction = actionSet[0] || ""; // Ultimate fallback
             }
        }
        
        console.log(`[ORACLE-WORKER] Reasoned Action: ${chosenAction}`);
        const mockCid = "QmOffChainDataNotImplementedYet"; 

        console.log(`[ORACLE-WORKER] Submitting transaction for Request #${requestId}...`);
        
        // Send tx
        const { request } = await client.simulateContract({
            address: CONTRACT_ADDRESS,
            abi,
            functionName: 'fulfillNodeReasoning',
            args: [BigInt(requestId), chosenAction, mockCid],
            account,
        });
        const hash = await walletClient.writeContract(request);
        
        console.log(`[ORACLE-WORKER] Tx broadcasted: ${hash}. Updating state to PROCESSED.`);
        updateStatusStmt.run('PROCESSED', Date.now(), requestId);
        
    } catch (err) {
        console.error(`[ORACLE-WORKER] AI or Tx Failure on Request #${requestId}:`, err.message);
    }
}

// Loop to check the db for PENDING tasks
async function startAiWorker() {
    setInterval(async () => {
        try {
            const pendingRequests = getPendingStmt.all();
            for (const req of pendingRequests) {
                await processOracleRequest(req);
            }
        } catch (e) {
            console.error(`[WORKER ERROR]:`, e.message);
        }
    }, 3000); // Check DB every 3s
}

// ==========================================
// 4. EVM Indexer (Sync logic)
// ==========================================
async function startIndexer() {
    let lastProcessedBlockStr = getSyncBlockStmt.get()?.lastProcessedBlock;
    let lastProcessedBlock;

    try {
        if (!lastProcessedBlockStr) {
            lastProcessedBlock = await client.getBlockNumber();
            updateSyncBlockStmt.run(lastProcessedBlock.toString());
        } else {
            lastProcessedBlock = BigInt(lastProcessedBlockStr);
        }
    } catch (e) {
        console.error("Critical RPC failure during boot:", e);
        process.exit(1);
    }
    
    console.log(`[INDEXER] HodlAI Oracle Node watching Flap Vault on ${RPC_URL} starting at block: ${lastProcessedBlock}`);
    
    setInterval(async () => {
         try {
             // EVM Hack: Force bundle the target block lookup and log scraping to the same load balancer node
             const [latestBlock, logsRequested, logsFulfilled] = await Promise.all([
                 client.getBlockNumber(),
                 client.getLogs({
                     address: CONTRACT_ADDRESS,
                     event: abi[0], // ReasoningRequested
                     fromBlock: lastProcessedBlock + 1n,
                     toBlock: 'latest' // Viem correctly resolves this on the same batch request
                 }),
                 client.getLogs({
                     address: CONTRACT_ADDRESS,
                     event: abi[1], // ReasoningFulfilled
                     fromBlock: lastProcessedBlock + 1n,
                     toBlock: 'latest'
                 })
             ]);

             // 1. Process new requests (Insert as PENDING)
             for (const log of logsRequested) {
                 const { requestId, requester, model, systemPrompt, stateString, actionSet } = log.args;
                 console.log(`[INDEXER] Captured ReasoningRequested #${requestId}`);
                 
                 insertRequestStmt.run(
                     requestId.toString(),
                     requester,
                     model,
                     systemPrompt,
                     stateString,
                     JSON.stringify([...actionSet]),
                     Date.now(),
                     Date.now()
                 );
             }

             // 2. Process completions (Update to FULFILLED)
             for (const log of logsFulfilled) {
                 const { requestId } = log.args;
                 console.log(`[INDEXER] Captured ReasoningFulfilled #${requestId}. Closing loop.`);
                 updateStatusStmt.run('FULFILLED', Date.now(), requestId.toString());
             }
             
             // 3. Advance pointer
             if (latestBlock > lastProcessedBlock) {
                 lastProcessedBlock = latestBlock;
                 updateSyncBlockStmt.run(lastProcessedBlock.toString());
             }
         } catch (e) {
             console.error("[INDEXER] Polling error:", e.message);
         }
    }, 5000); // Poll chain every 5s
}

// Start processes
startIndexer();
startAiWorker();
