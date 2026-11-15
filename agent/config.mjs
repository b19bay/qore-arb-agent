// Shared config for the agent scripts. Values come from environment (or a
// local agent/.env file, which is git-ignored and NEVER committed — the agent
// private key lives ONLY there / in the environment at runtime).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const path = join(dir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see agent/.env.example)`);
  return v;
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

export const config = {
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  chainId: num("CHAIN_ID", 9800),
  chainName: process.env.CHAIN_NAME || "QoreChain Devnet",
  vaultAddress: process.env.VAULT_ADDRESS || "",
  poolA: process.env.POOL_A || "",
  poolB: process.env.POOL_B || "",
  tokenAddress: process.env.TOKEN_ADDRESS || "",
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY || "",
  tradeSizeQor: num("TRADE_SIZE_QOR", 0.2),
  spreadThresholdBps: num("SPREAD_THRESHOLD_BPS", 50), // 0.5%
  slippageBps: num("SLIPPAGE_BPS", 100), // 1%
  intervalSeconds: num("INTERVAL_SECONDS", 30),
  maxTrades: num("MAX_TRADES", 4),
  durationMinutes: num("DURATION_MINUTES", 10),
  gasMode: process.env.GAS_MODE || "legacy", // legacy | eip1559
  fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
};

export function requireAddresses() {
  for (const [k, v] of [
    ["VAULT_ADDRESS", config.vaultAddress],
    ["POOL_A", config.poolA],
    ["POOL_B", config.poolB],
    ["TOKEN_ADDRESS", config.tokenAddress],
  ]) {
    if (!v) throw new Error(`Missing required env var ${k} — deploy first, then fill agent/.env`);
  }
}

export function requireAgentKey() {
  return req("AGENT_PRIVATE_KEY");
}

export function qoreChain() {
  return {
    id: config.chainId,
    name: config.chainName,
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  };
}

export const agentDir = dir;
