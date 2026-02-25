require('dotenv').config();
console.log(process.env.ORACLE_WALLET_PK ? "PK loaded" : "PK not loaded");
