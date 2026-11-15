// Audit-log exporter: rebuilds the vault's full audit trail from on-chain
// events (TradeExecuted, AutoHalted, Halted, Resumed, PolicyUpdated,
// AgentChanged, Withdrawn, Deposited) — reproducible from the chain, never
// from agent memory. Writes audit-log-<date>.json + audit-log-<date>.csv.
//
// Usage: node export-audit-log.mjs [--out-prefix NAME]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, formatEther } from "viem";
import { config, requireAddresses, qoreChain, agentDir } from "./config.mjs";
import { vaultAbi } from "./abis.mjs";

async function main() {
  requireAddresses();
  const prefixIdx = process.argv.indexOf("--out-prefix");
  const prefix = prefixIdx === -1 ? "audit-log" : process.argv[prefixIdx + 1];
  const date = new Date().toISOString().slice(0, 10);

  const publicClient = createPublicClient({ chain: qoreChain(), transport: http(config.rpcUrl) });
  const blockCache = new Map();
  async function blockTime(number) {
    if (!blockCache.has(number)) {
      const b = await publicClient.getBlock({ blockNumber: number });
      blockCache.set(number, b.timestamp);
    }
    return blockCache.get(number);
  }

  const eventNames = ["TradeExecuted", "AutoHalted", "Halted", "Resumed", "PolicyUpdated", "AgentChanged", "Withdrawn", "Deposited"];
  const entries = [];
  for (const eventName of eventNames) {
    const logs = await publicClient.getLogs({
      address: config.vaultAddress,
      event: vaultAbi.find((e) => e.type === "event" && e.name === eventName),
      fromBlock: config.fromBlock,
      toBlock: "latest",
    });
    for (const l of logs) {
      const ts = await blockTime(l.blockNumber);
      const base = {
        event: eventName,
        blockNumber: l.blockNumber.toString(),
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        timestamp: new Date(Number(ts) * 1000).toISOString(),
      };
      const a = l.args;
      if (eventName === "TradeExecuted") {
        entries.push({
          ...base,
          tradeId: a.id.toString(),
          target: a.target,
          valueInQor: formatEther(a.valueIn),
          valueOut: formatEther(a.valueOut),
          pnl: (a.pnl < 0n ? "-" : "") + formatEther(a.pnl < 0n ? -a.pnl : a.pnl),
          profitable: a.profitable,
        });
      } else if (eventName === "AutoHalted") {
        entries.push({ ...base, reason: a.reason });
      } else if (eventName === "Deposited") {
        entries.push({ ...base, from: a.from, amountQor: formatEther(a.amount) });
      } else if (eventName === "Withdrawn") {
        entries.push({ ...base, to: a.to, amountQor: formatEther(a.amount) });
      } else if (eventName === "PolicyUpdated") {
        entries.push({
          ...base,
          maxPerTradeQor: formatEther(a.maxPerTrade),
          dailyLimitQor: formatEther(a.dailyLimit),
          authExpiry: new Date(Number(a.authExpiry) * 1000).toISOString(),
          maxConsecutiveLosses: a.maxConsecutiveLosses.toString(),
        });
      } else if (eventName === "AgentChanged") {
        entries.push({ ...base, oldAgent: a.oldAgent, newAgent: a.newAgent });
      } else if (eventName === "Halted" || eventName === "Resumed") {
        entries.push({ ...base, by: a.by });
      }
    }
  }
  entries.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || x.logIndex - y.logIndex);

  const trades = entries.filter((e) => e.event === "TradeExecuted");
  const out = {
    exportedAt: new Date().toISOString(),
    chainId: config.chainId,
    vault: config.vaultAddress,
    fromBlock: config.fromBlock.toString(),
    summary: {
      totalEvents: entries.length,
      trades: trades.length,
      profitableTrades: trades.filter((t) => t.profitable).length,
      autoHalts: entries.filter((e) => e.event === "AutoHalted").length,
    },
    entries,
  };
  const jsonPath = join(agentDir, `${prefix}-${date}.json`);
  writeFileSync(jsonPath, JSON.stringify(out, null, 2) + "\n");

  const header = "timestamp,event,blockNumber,txHash,tradeId,target,valueInQor,valueOut,pnl,profitable,detail\n";
  const csv = header + entries.map((e) => [
    e.timestamp, e.event, e.blockNumber, e.txHash, e.tradeId ?? "", e.target ?? "",
    e.valueInQor ?? "", e.valueOut ?? "", e.pnl ?? "", e.profitable ?? "",
    JSON.stringify({ reason: e.reason, from: e.from, to: e.to, amountQor: e.amountQor, by: e.by, oldAgent: e.oldAgent, newAgent: e.newAgent }),
  ].join(",")).join("\n") + "\n";
  const csvPath = join(agentDir, `${prefix}-${date}.csv`);
  writeFileSync(csvPath, csv);

  console.log(`[audit] ${entries.length} events (${trades.length} trades, ${out.summary.autoHalts} auto-halts)`);
  console.log(`[audit] wrote ${jsonPath}`);
  console.log(`[audit] wrote ${csvPath}`);
}

main().catch((err) => {
  console.error(`[audit] FATAL: ${err.stack ?? err}`);
  process.exit(1);
});
