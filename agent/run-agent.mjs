// Arbitrage agent runner: observe -> decide -> execute through the vault.
// One recorded run (not a 24/7 daemon): --max-trades N --duration-minutes M.
// Writes agent/run-log-<date>.json with every observation, decision and tx.
//
// The agent NEVER sends a trade the vault would reject: it mirrors every
// on-chain gate locally first (see decision.mjs checkLocalLimits) and logs
// local rejections. The vault remains the final enforcer — local checks are
// an optimisation, not the security boundary.
//
// Usage:
//   node run-agent.mjs [--max-trades N] [--duration-minutes M]
//                      [--interval-seconds S] [--threshold-bps B]
//                      [--trade-size QOR] [--dry-run]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, requireAddresses, requireAgentKey, qoreChain, agentDir } from "./config.mjs";
import { vaultAbi, poolAbi } from "./abis.mjs";
import {
  bestDirection,
  quoteOut,
  simulateRoundTrip,
  shouldTrade,
  checkLocalLimits,
  fitBuySize,
  minOutWithSlippage,
  shouldStop,
} from "./decision.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max-trades") out.maxTrades = Number(argv[++i]);
    else if (a === "--duration-minutes") out.durationMinutes = Number(argv[++i]);
    else if (a === "--interval-seconds") out.intervalSeconds = Number(argv[++i]);
    else if (a === "--threshold-bps") out.thresholdBps = Number(argv[++i]);
    else if (a === "--trade-size") out.tradeSizeQor = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const fmt = (wei) => formatEther(wei);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireAddresses();
  const maxTrades = args.maxTrades ?? config.maxTrades;
  const durationMs = (args.durationMinutes ?? config.durationMinutes) * 60 * 1000;
  const intervalMs = (args.intervalSeconds ?? config.intervalSeconds) * 1000;
  const thresholdBps = BigInt(args.thresholdBps ?? config.spreadThresholdBps);
  const tradeSize = parseEther(String(args.tradeSizeQor ?? config.tradeSizeQor));
  const dryRun = args.dryRun ?? false;

  const chain = qoreChain();
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const account = privateKeyToAccount(requireAgentKey());
  const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

  const log = {
    startedAt: nowIso(),
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    vault: config.vaultAddress,
    poolA: config.poolA,
    poolB: config.poolB,
    token: config.tokenAddress,
    agent: account.address,
    params: {
      maxTrades,
      durationMinutes: durationMs / 60000,
      intervalSeconds: intervalMs / 1000,
      thresholdBps: thresholdBps.toString(),
      tradeSizeQor: fmt(tradeSize),
      slippageBps: config.slippageBps,
      dryRun,
    },
    observations: [],
    trades: [],
    rejections: [],
    stopReason: null,
    endedAt: null,
  };
  const logPath = join(agentDir, `run-log-${new Date().toISOString().slice(0, 10)}.json`);
  const flush = () => writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
  flush();

  console.log(`[agent] start ${log.startedAt} agent=${account.address} vault=${config.vaultAddress}`);
  console.log(`[agent] maxTrades=${maxTrades} duration=${durationMs / 60000}min interval=${intervalMs / 1000}s threshold=${thresholdBps}bps tradeSize=${fmt(tradeSize)} QOR dryRun=${dryRun}`);

  const deadline = Date.now() + durationMs;
  let tradesDone = 0;
  let iteration = 0;

  // Gas settings: the devnet EVM accepts EIP-155 legacy txs; viem defaults
  // to EIP-1559 estimation which this node answers unreliably, so legacy +
  // explicit gasPrice is the default (GAS_MODE=eip1559 to override).
  async function txOverrides() {
    if (config.gasMode === "eip1559") return {};
    const gasPrice = await publicClient.getGasPrice();
    return { type: "legacy", gasPrice };
  }

  async function executeLeg(target, data, valueIn, minOut, label) {
    const hash = await walletClient.writeContract({
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: "executeTrade",
      args: [target, data, valueIn, minOut],
      ...(await txOverrides()),
    });
    console.log(`[agent] ${label} sent: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} tx reverted on-chain: ${hash}`);
    const events = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: "TradeExecuted" });
    const ev = events[0]?.args;
    return { hash, receipt, event: ev };
  }

  while (Date.now() < deadline && tradesDone < maxTrades) {
    iteration++;
    const t0 = nowIso();
    try {
      const [resA, resB, vault] = await Promise.all([
        publicClient.readContract({ address: config.poolA, abi: poolAbi, functionName: "getReserves" }),
        publicClient.readContract({ address: config.poolB, abi: poolAbi, functionName: "getReserves" }),
        (async () => {
          const [halted, authExpiry, maxPerTrade, dailyLimit, spent24h, consecutiveLosses, balance, qatBalance, allowedA, allowedB] =
            await Promise.all([
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "halted" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "authExpiry" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "maxPerTrade" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "dailyLimit" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "spentLast24h" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "consecutiveLosses" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "balance" }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "tokenBalance", args: [config.tokenAddress] }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "isAllowed", args: [config.poolA] }),
              publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: "isAllowed", args: [config.poolB] }),
            ]);
          return { halted, authExpiry, maxPerTrade, dailyLimit, spent24h, consecutiveLosses, balance, qatBalance, allowedA, allowedB };
        })(),
      ]);

      const poolAState = { reserveQor: resA[0], reserveToken: resA[1] };
      const poolBState = { reserveQor: resB[0], reserveToken: resB[1] };
      const nowSec = Math.floor(Date.now() / 1000);

      const stop = shouldStop({
        halted: vault.halted,
        nowSec,
        authExpiry: Number(vault.authExpiry),
        spent24h: vault.spent24h,
        dailyLimit: vault.dailyLimit,
      });
      if (stop) {
        log.stopReason = stop;
        console.log(`[agent] STOP: ${stop}`);
        break;
      }

      // REVISION 1 — two-way arbitrage: simulate BOTH directions and trade
      // whichever spread is better (run 1 proved a one-direction agent goes
      // idle once its own trade flips the spread). The direction is picked
      // at the configured size, then the buy is fitted to the per-trade cap
      // for the chosen buy pool and re-simulated at the fitted size.
      const best = bestDirection(tradeSize, poolAState, poolBState);
      const buyPoolAddr = best.direction === "A->B" ? config.poolA : config.poolB;
      const sellPoolAddr = best.direction === "A->B" ? config.poolB : config.poolA;
      const buyAllowed = best.direction === "A->B" ? vault.allowedA : vault.allowedB;
      const sellAllowed = best.direction === "A->B" ? vault.allowedB : vault.allowedA;
      const buySize = fitBuySize(tradeSize, vault.maxPerTrade, best.buyPool);
      const sim = simulateRoundTrip(buySize, best.buyPool, best.sellPool);
      const simAB = simulateRoundTrip(tradeSize, poolAState, poolBState);
      const simBA = simulateRoundTrip(tradeSize, poolBState, poolAState);
      const obs = {
        at: t0,
        iteration,
        poolA: { qor: fmt(poolAState.reserveQor), qat: fmt(poolAState.reserveToken) },
        poolB: { qor: fmt(poolBState.reserveQor), qat: fmt(poolBState.reserveToken) },
        spreadABbps: simAB.spreadBps.toString(),
        spreadBAbps: simBA.spreadBps.toString(),
        direction: best.direction,
        buySizeQor: fmt(buySize),
        expectedQatOut: fmt(sim.qatOut),
        expectedQorOut: fmt(sim.qorOut),
        expectedProfitQor: fmt(sim.profit),
        spreadBps: sim.spreadBps.toString(),
        vault: {
          halted: vault.halted,
          spent24hQor: fmt(vault.spent24h),
          dailyLimitQor: fmt(vault.dailyLimit),
          balanceQor: fmt(vault.balance),
          qatBalance: fmt(vault.qatBalance),
          consecutiveLosses: vault.consecutiveLosses.toString(),
        },
        decision: null,
      };

      if (buySize === 0n) {
        obs.decision = "skip: no buy size fits the per-trade cap";
      } else if (!shouldTrade(sim.spreadBps, thresholdBps)) {
        obs.decision = `skip: spread ${sim.spreadBps}bps <= threshold ${thresholdBps}bps`;
      } else {
        // Local mirror of the on-chain gates, for BOTH legs.
        const leg1 = checkLocalLimits({
          valueIn: buySize,
          maxPerTrade: vault.maxPerTrade,
          spent24h: vault.spent24h,
          dailyLimit: vault.dailyLimit,
          targetAllowed: buyAllowed,
          authExpiry: Number(vault.authExpiry),
          nowSec,
          halted: vault.halted,
          vaultBalance: vault.balance,
        });
        const leg2 = checkLocalLimits({
          valueIn: sim.qatOut,
          maxPerTrade: vault.maxPerTrade,
          spent24h: vault.spent24h + buySize,
          dailyLimit: vault.dailyLimit,
          targetAllowed: sellAllowed,
          authExpiry: Number(vault.authExpiry),
          nowSec,
          halted: vault.halted,
          vaultBalance: vault.balance, // sell leg attaches QOR that is refunded
        });
        if (!leg1.ok || !leg2.ok) {
          const reasons = [...leg1.reasons.map((r) => `leg1: ${r}`), ...leg2.reasons.map((r) => `leg2: ${r}`)];
          obs.decision = `reject-local: ${reasons.join("; ")}`;
          log.rejections.push({ at: t0, iteration, direction: best.direction, spreadBps: sim.spreadBps.toString(), reasons });
          console.log(`[agent] iter ${iteration}: spread ${sim.spreadBps}bps (${best.direction}) but REJECTED locally: ${reasons.join("; ")}`);
        } else if (dryRun) {
          obs.decision = `would-trade (dry-run): spread ${sim.spreadBps}bps (${best.direction})`;
          console.log(`[agent] iter ${iteration}: spread ${sim.spreadBps}bps (${best.direction}) — dry-run, no tx sent`);
        } else {
          obs.decision = `trade: spread ${sim.spreadBps}bps (${best.direction})`;
          console.log(`[agent] iter ${iteration}: spread ${sim.spreadBps}bps (${best.direction}) — executing round trip (buy ${fmt(buySize)} QOR)`);
          const minOut1 = minOutWithSlippage(sim.qatOut, config.slippageBps);
          const leg1Tx = await executeLeg(
            buyPoolAddr,
            encodeFunctionData({ abi: poolAbi, functionName: "swapQorForToken", args: [minOut1] }),
            buySize,
            minOut1,
            "leg1 buy"
          );
          tradesDone++;
          const qatHeld = await publicClient.readContract({
            address: config.vaultAddress, abi: vaultAbi, functionName: "tokenBalance", args: [config.tokenAddress],
          });
          // Re-quote leg 2 from FRESH sell-pool reserves and the actual QAT
          // held (never trust the pre-trade simulation for minOut).
          const resSell2 = await publicClient.readContract({ address: sellPoolAddr, abi: poolAbi, functionName: "getReserves" });
          const expectedQor2 = quoteOut(qatHeld, resSell2[1], resSell2[0]);
          const minOut2 = minOutWithSlippage(expectedQor2, config.slippageBps);
          const leg2Tx = await executeLeg(
            sellPoolAddr,
            encodeFunctionData({ abi: poolAbi, functionName: "swapTokenForQor", args: [qatHeld, minOut2] }),
            qatHeld,
            minOut2,
            "leg2 sell"
          );
          tradesDone++;
          // Gas accounting (REVISION 1): every leg's gas cost is recorded
          // from its receipt, so each round trip reports gross profit, gas
          // cost, and NET profit. The agent EOA pays gas; the vault keeps
          // the gross profit. At devnet gas prices (~112.5 gwei) and demo
          // pool depth, a round trip can be gross-profitable but
          // gas-negative — the log shows both, never just the flattering one.
          const gasCostLeg = (r) => (r.receipt.gasUsed ?? 0n) * (r.receipt.effectiveGasPrice ?? 0n);
          const gas1 = gasCostLeg(leg1Tx);
          const gas2 = gasCostLeg(leg2Tx);
          const grossProfit = leg2Tx.event ? BigInt(leg2Tx.event.valueOut) - buySize : 0n;
          const roundTrip = {
            at: t0,
            iteration,
            direction: best.direction,
            buySizeQor: fmt(buySize),
            leg1: { hash: leg1Tx.hash, valueIn: fmt(buySize), valueOut: leg1Tx.event ? fmt(leg1Tx.event.valueOut) : null, tradeId: leg1Tx.event ? leg1Tx.event.id.toString() : null, gasUsed: leg1Tx.receipt.gasUsed?.toString(), gasCostQor: fmt(gas1) },
            leg2: { hash: leg2Tx.hash, valueIn: fmt(qatHeld), valueOut: leg2Tx.event ? fmt(leg2Tx.event.valueOut) : null, tradeId: leg2Tx.event ? leg2Tx.event.id.toString() : null, gasUsed: leg2Tx.receipt.gasUsed?.toString(), gasCostQor: fmt(gas2) },
            profitQor: fmt(grossProfit),
            gasCostQor: fmt(gas1 + gas2),
            netProfitQor: fmt(grossProfit - gas1 - gas2),
            spreadBps: sim.spreadBps.toString(),
          };
          log.trades.push(roundTrip);
          console.log(`[agent] round trip done (${best.direction}): gross +${roundTrip.profitQor} QOR, gas ${roundTrip.gasCostQor} QOR, net ${roundTrip.netProfitQor} QOR`);
        }
      }
      log.observations.push(obs);
      if (!obs.decision.startsWith("trade:")) {
        console.log(`[agent] iter ${iteration}: spread AB ${simAB.spreadBps}bps / BA ${simBA.spreadBps}bps, ${obs.decision}`);
      }
    } catch (err) {
      console.error(`[agent] iter ${iteration} ERROR: ${err.message}`);
      log.observations.push({ at: t0, iteration, error: String(err.message ?? err) });
    }
    flush();
    if (tradesDone >= maxTrades) {
      log.stopReason = `max trades reached (${maxTrades})`;
      console.log(`[agent] STOP: ${log.stopReason}`);
      break;
    }
    // Pace every iteration by the full interval (the deadline is checked at
    // the top of the loop, so the run may overshoot it by up to one
    // interval — accepted; skipping the sleep near the deadline caused
    // rapid-fire iterations instead).
    if (Date.now() < deadline) await sleep(Math.min(intervalMs, deadline - Date.now()));
  }

  if (!log.stopReason) log.stopReason = "duration elapsed";
  log.endedAt = nowIso();
  log.summary = {
    iterations: iteration,
    tradesExecuted: tradesDone,
    roundTrips: log.trades.length,
    totalProfitQor: log.trades.reduce((a, t) => a + Number(t.profitQor ?? 0), 0).toFixed(18),
    totalGasCostQor: log.trades.reduce((a, t) => a + Number(t.gasCostQor ?? 0), 0).toFixed(18),
    totalNetProfitQor: log.trades.reduce((a, t) => a + Number(t.netProfitQor ?? 0), 0).toFixed(18),
    rejections: log.rejections.length,
  };
  flush();
  console.log(`[agent] done. stopReason=${log.stopReason} trades=${tradesDone} roundTrips=${log.trades.length} log=${logPath}`);
}

main().catch((err) => {
  console.error(`[agent] FATAL: ${err.stack ?? err}`);
  process.exit(1);
});
