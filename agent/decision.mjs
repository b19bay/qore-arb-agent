// Pure decision logic for the arbitrage agent. No network access, no viem —
// every function here is unit-tested in decision.test.mjs. All amounts are
// BigInt wei (18 decimals). Prices are implicit in pool reserves.

export const FEE_BPS = 30n; // 0.30% per swap, mirrors x/amm swap_fee_bps
export const BPS_DENOM = 10_000n;

/// Constant-product quote with fee on the input: out = inAfterFee * reserveOut
/// / (reserveIn + inAfterFee). Mirrors SimplePool.getAmountOut exactly.
export function quoteOut(amountIn, reserveIn, reserveOut, feeBps = FEE_BPS) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inAfterFee = (amountIn * (BPS_DENOM - feeBps)) / BPS_DENOM;
  return (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
}

/// Simulate a full round trip at a given size: buy QAT on pool A (QOR in),
/// sell all received QAT on pool B (QOR out). Returns the net result in wei
/// and in basis points of the input. Price impact and both swap fees are
/// included because the quotes are computed at size.
/// NOTE: the parameters are positional — call with (buy, poolB, poolA) to
/// simulate the REVERSE direction (buy on B, sell on A).
export function simulateRoundTrip(buyQor, poolA, poolB) {
  const qatOut = quoteOut(buyQor, poolA.reserveQor, poolA.reserveToken);
  const qorOut = quoteOut(qatOut, poolB.reserveToken, poolB.reserveQor);
  const profit = qorOut - buyQor;
  const spreadBps = buyQor > 0n ? (profit * BPS_DENOM) / buyQor : 0n;
  return { qatOut, qorOut, profit, spreadBps };
}

/// Simulate BOTH directions at a given size and return the better one.
/// Revision 1 (motivated by run 1, 2026-11-16): after one A->B round trip
/// the pools' spread FLIPPED (A became the expensive pool), so a
/// one-direction agent sat idle at -1393bps while the reverse direction was
/// profitable. An arbitrageur must trade whichever direction the spread
/// points. Ties prefer A->B (deterministic).
export function bestDirection(buyQor, poolA, poolB) {
  const ab = simulateRoundTrip(buyQor, poolA, poolB);
  const ba = simulateRoundTrip(buyQor, poolB, poolA);
  if (ba.spreadBps > ab.spreadBps) {
    return { direction: "B->A", buyPool: poolB, sellPool: poolA, ...ba };
  }
  return { direction: "A->B", buyPool: poolA, sellPool: poolB, ...ab };
}

/// Strictly-greater threshold: a spread exactly AT the threshold does NOT
/// trade (edge case covered by tests).
export function shouldTrade(spreadBps, thresholdBps) {
  return spreadBps > thresholdBps;
}

/// Mirror of the vault's on-chain gates, checked locally BEFORE sending a
/// trade so the agent never submits a tx the vault is certain to reject.
/// `nowSec` is unix seconds. Returns { ok, reasons[] }.
export function checkLocalLimits({
  valueIn,
  maxPerTrade,
  spent24h,
  dailyLimit,
  targetAllowed,
  authExpiry,
  nowSec,
  halted,
  vaultBalance,
}) {
  const reasons = [];
  if (halted) reasons.push("vault halted");
  if (nowSec > authExpiry) reasons.push("authorisation expired");
  if (!targetAllowed) reasons.push("target not allowlisted");
  if (valueIn <= 0n) reasons.push("valueIn is zero");
  if (valueIn > maxPerTrade) reasons.push("exceeds per-trade cap");
  if (spent24h + valueIn > dailyLimit) reasons.push("exceeds daily limit");
  if (valueIn > vaultBalance) reasons.push("insufficient vault balance");
  return { ok: reasons.length === 0, reasons };
}

/// The sell leg spends QAT, and the vault counts the QAT amount against the
/// same per-trade cap. Find the largest buy size <= desired whose QAT output
/// fits the cap, via binary search (the quote is monotonic in the input, so
/// this is exact; a proportional fixed-point iteration converges to the cap
/// from above and never lands below it).
export function fitBuySize(desiredBuy, maxPerTrade, poolA) {
  if (quoteOut(desiredBuy, poolA.reserveQor, poolA.reserveToken) <= maxPerTrade) {
    return desiredBuy;
  }
  let lo = 0n; // fits (quote(0) = 0)
  let hi = desiredBuy; // does not fit
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (quoteOut(mid, poolA.reserveQor, poolA.reserveToken) <= maxPerTrade) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/// minOut with slippage tolerance in bps (e.g. 50 = 0.5%).
export function minOutWithSlippage(expectedOut, slippageBps) {
  if (expectedOut <= 0n) return 0n;
  return (expectedOut * (BPS_DENOM - BigInt(slippageBps))) / BPS_DENOM;
}

/// Should the agent stop itself? Mirrors the run-loop exit conditions.
export function shouldStop({ halted, nowSec, authExpiry, spent24h, dailyLimit }) {
  if (halted) return "vault halted";
  if (nowSec > authExpiry) return "authorisation expired";
  if (spent24h >= dailyLimit) return "daily budget exhausted";
  return null;
}
