// Unit tests for the agent's pure decision logic (no network).
// Run: npm test   (node --test decision.test.mjs)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEE_BPS,
  bestDirection,
  quoteOut,
  simulateRoundTrip,
  shouldTrade,
  checkLocalLimits,
  fitBuySize,
  minOutWithSlippage,
  shouldStop,
} from "./decision.mjs";

const ether = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // up to 6 decimals
// Demo pools: A cheap (3.5 QOR / 3.85 QAT), B expensive (3.5 QOR / 3.15 QAT).
const poolA = { reserveQor: ether(3.5), reserveToken: ether(3.85) };
const poolB = { reserveQor: ether(3.5), reserveToken: ether(3.15) };

describe("quoteOut", () => {
  it("matches the constant-product formula with fee", () => {
    // in=0.2, fee 0.3% -> 0.1994; out = 0.1994*3.85/(3.5+0.1994)
    const out = quoteOut(ether(0.2), poolA.reserveQor, poolA.reserveToken);
    const expected = (1994n * 10n ** 14n * 385n * 10n ** 16n) / (36994n * 10n ** 14n);
    assert.equal(out, expected);
    assert(out > ether(0.2)); // QAT is cheap on A
  });
  it("returns 0 for zero input or empty reserves", () => {
    assert.equal(quoteOut(0n, 1n, 1n), 0n);
    assert.equal(quoteOut(1n, 0n, 1n), 0n);
    assert.equal(quoteOut(1n, 1n, 0n), 0n);
  });
  it("price impact grows with size", () => {
    const small = quoteOut(ether(0.01), poolA.reserveQor, poolA.reserveToken);
    const big = quoteOut(ether(1), poolA.reserveQor, poolA.reserveToken);
    // Effective rate (out/in) must be worse for the big trade.
    assert(small * ether(1) > big * ether(0.01));
  });
});

describe("simulateRoundTrip", () => {
  it("finds the real profit on divergent pools", () => {
    const r = simulateRoundTrip(ether(0.2), poolA, poolB);
    assert(r.profit > 0n);
    assert(r.spreadBps > 0n);
    // ~8% net at this size (marginal spread ~20% minus impact + fees).
    assert(r.spreadBps > 500n && r.spreadBps < 1500n);
  });
  it("loses money on identical pools (fees + impact)", () => {
    const r = simulateRoundTrip(ether(0.2), poolA, poolA);
    assert(r.profit < 0n);
    assert(r.spreadBps < 0n);
  });
  it("loses money when the spread is inverted", () => {
    const r = simulateRoundTrip(ether(0.2), poolB, poolA);
    assert(r.profit < 0n);
  });
  it("a too-large trade loses to price impact", () => {
    const r = simulateRoundTrip(ether(3), poolA, poolB);
    assert(r.profit < 0n);
  });
});

describe("shouldTrade", () => {
  it("trades above the threshold", () => {
    assert.equal(shouldTrade(51n, 50n), true);
  });
  it("does NOT trade exactly at the threshold (edge)", () => {
    assert.equal(shouldTrade(50n, 50n), false);
  });
  it("does NOT trade below the threshold or negative", () => {
    assert.equal(shouldTrade(49n, 50n), false);
    assert.equal(shouldTrade(-100n, 50n), false);
  });
});

describe("checkLocalLimits", () => {
  const base = {
    valueIn: ether(0.2),
    maxPerTrade: ether(0.5),
    spent24h: ether(0.5),
    dailyLimit: ether(2),
    targetAllowed: true,
    authExpiry: 2_000_000_000,
    nowSec: 1_800_000_000,
    halted: false,
    vaultBalance: ether(10),
  };
  it("passes when everything is within limits", () => {
    assert.deepEqual(checkLocalLimits(base), { ok: true, reasons: [] });
  });
  it("allows valueIn exactly at the per-trade cap (edge)", () => {
    assert.equal(checkLocalLimits({ ...base, valueIn: ether(0.5) }).ok, true);
  });
  it("rejects valueIn one wei over the cap", () => {
    const r = checkLocalLimits({ ...base, valueIn: ether(0.5) + 1n });
    assert.equal(r.ok, false);
    assert(r.reasons.includes("exceeds per-trade cap"));
  });
  it("allows spending exactly up to the daily limit (edge)", () => {
    assert.equal(
      checkLocalLimits({ ...base, spent24h: ether(1.8), valueIn: ether(0.2) }).ok,
      true
    );
  });
  it("rejects one wei over the daily limit", () => {
    const r = checkLocalLimits({ ...base, spent24h: ether(1.8), valueIn: ether(0.2) + 1n });
    assert.equal(r.ok, false);
    assert(r.reasons.includes("exceeds daily limit"));
  });
  it("rejects halted vault, expired auth, unlisted target, low balance", () => {
    assert(checkLocalLimits({ ...base, halted: true }).reasons.includes("vault halted"));
    assert(
      checkLocalLimits({ ...base, nowSec: 2_000_000_001 }).reasons.includes(
        "authorisation expired"
      )
    );
    assert(
      checkLocalLimits({ ...base, targetAllowed: false }).reasons.includes(
        "target not allowlisted"
      )
    );
    assert(
      checkLocalLimits({ ...base, vaultBalance: ether(0.1) }).reasons.includes(
        "insufficient vault balance"
      )
    );
  });
  it("auth valid exactly at expiry second (edge: expiry is inclusive)", () => {
    assert.equal(checkLocalLimits({ ...base, nowSec: 2_000_000_000 }).ok, true);
  });
});

describe("fitBuySize", () => {
  it("keeps the desired size when QAT output already fits", () => {
    assert.equal(fitBuySize(ether(0.2), ether(0.5), poolA), ether(0.2));
  });
  it("shrinks the buy so QAT output fits the cap", () => {
    // A 0.6 QOR buy would yield ~0.562 QAT > 0.5 cap, so it must shrink.
    const buy = fitBuySize(ether(0.6), ether(0.5), poolA);
    assert(buy < ether(0.6));
    assert(quoteOut(buy, poolA.reserveQor, poolA.reserveToken) <= ether(0.5));
    assert(buy > ether(0.5)); // must not shrink more than needed
  });
});

describe("minOutWithSlippage", () => {
  it("applies the tolerance", () => {
    assert.equal(minOutWithSlippage(ether(1), 50), ether(0.995));
    assert.equal(minOutWithSlippage(ether(1), 0), ether(1));
    assert.equal(minOutWithSlippage(0n, 50), 0n);
  });
});

describe("shouldStop", () => {
  it("returns null while healthy", () => {
    assert.equal(
      shouldStop({ halted: false, nowSec: 100, authExpiry: 200, spent24h: 1n, dailyLimit: 2n }),
      null
    );
  });
  it("stops when halted, expired, or budget exactly exhausted (edge)", () => {
    const base = { halted: false, nowSec: 100, authExpiry: 200, spent24h: 1n, dailyLimit: 2n };
    assert.equal(shouldStop({ ...base, halted: true }), "vault halted");
    assert.equal(shouldStop({ ...base, nowSec: 201 }), "authorisation expired");
    assert.equal(shouldStop({ ...base, spent24h: 2n }), "daily budget exhausted");
    assert.equal(shouldStop({ ...base, spent24h: 1n }), null);
  });
});

describe("bestDirection (revision 1: two-way arbitrage)", () => {
  it("picks A->B on the freshly seeded pools", () => {
    const b = bestDirection(ether(0.2), poolA, poolB);
    assert.equal(b.direction, "A->B");
    assert(b.spreadBps > 0n);
  });
  it("picks B->A after run 1 flipped the spread (real post-run reserves)", () => {
    // Reserves after run 1's round trip (read from chain, 2026-11-16):
    // A: 3.7 QOR / 3.642482564740228146 QAT, B: 3.284285145770857796 QOR /
    // 3.357517435259771854 QAT. A->B is now -1393bps; B->A is the better
    // direction (still negative at 0.2 size — impact — but far better).
    const postA = { reserveQor: 3700000000000000000n, reserveToken: 3642482564740228146n };
    const postB = { reserveQor: 3284285145770857796n, reserveToken: 3357517435259771854n };
    const ab = simulateRoundTrip(ether(0.2), postA, postB);
    const ba = simulateRoundTrip(ether(0.2), postB, postA);
    assert(ab.spreadBps < 0n);
    assert(ba.spreadBps > ab.spreadBps);
    const b = bestDirection(ether(0.2), postA, postB);
    assert.equal(b.direction, "B->A");
    assert.equal(b.spreadBps, ba.spreadBps);
  });
  it("finds the reverse direction profitable at small size on flipped pools", () => {
    const postA = { reserveQor: 3700000000000000000n, reserveToken: 3642482564740228146n };
    const postB = { reserveQor: 3284285145770857796n, reserveToken: 3357517435259771854n };
    const b = bestDirection(ether(0.02), postA, postB);
    assert.equal(b.direction, "B->A");
    assert(b.spreadBps > 50n); // above the 50bps demo threshold
  });
  it("prefers A->B on a tie (identical pools)", () => {
    const b = bestDirection(ether(0.2), poolA, poolA);
    assert.equal(b.direction, "A->B");
  });
});

describe("FEE_BPS", () => {
  it("is 30 bps like x/amm", () => {
    assert.equal(FEE_BPS, 30n);
  });
});
