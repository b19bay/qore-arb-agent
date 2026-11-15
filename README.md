# Qore Arb Agent — autonomous arbitrage with on-chain limits

**Build Before Q-Day (QoreChain Developer Fest) · Category: Post-Quantum AI Agents**

An autonomous agent that executes arbitrage between two AMM pools — with
**every limit enforced on-chain by the vault contract**: per-trade cap,
rolling 24h daily cap, target allowlist, authorisation expiry, auto-halt on
consecutive losses or budget exhaustion, and a full on-chain audit log.

## Why this entry is different

- **Arbitrage is the event's own example that nobody built.** Of the 9 agent
  entries in the fest, there are 2 DCA agents, 3 treasury/payment agents,
  1 wallet, 1 visualisation, 1 governance engine, and 1 inference plan —
  zero arbitrage agents. This entry is the arbitrage agent.
- **Auto-halt + on-chain audit log** are not owned by any other agent in the
  fest. The vault halts itself after N consecutive losses or when the daily
  budget is exhausted, and every trade, halt, and policy change is an
  on-chain event that anyone can rebuild into an audit log.
- **The limits live in the contract, not in the agent's good intentions.**
  The agent mirrors the limits locally (so it never submits a doomed tx),
  but the vault is the enforcer: the agent cannot change policy, withdraw
  funds, or call anything outside the allowlist — verified by 32 Foundry
  tests including a reentrancy attack test.

## Architecture

```
                    ┌─────────────────────────────┐
  off-chain agent   │  agent/run-agent.mjs (viem) │
  (Node.js, viem)   │  observe → decide → execute │
                    │  decision.mjs (pure logic,  │
                    │  27 unit tests)             │
                    └──────────────┬──────────────┘
                                   │ executeTrade (signed by agent key)
                    ┌──────────────▼──────────────┐
  on-chain (EVM)    │  AgentVault.sol             │
  QoreChain devnet  │  caps · allowlist · expiry  │
  (chain id 9800)   │  auto-halt · audit events   │
                    └──────┬───────────────┬──────┘
                           │ swap          │ swap
                    ┌──────▼──────┐ ┌──────▼──────┐
                    │ SimplePool A│ │ SimplePool B│  x*y=k, 0.3% fee
                    │ QOR / QAT   │ │ QOR / QAT   │  (same curve + fee as
                    └─────────────┘ └─────────────┘   x/amm constant_product)
```

- `contracts/src/AgentVault.sol` — the vault (owner/agent roles, policy,
  rolling-24h accounting, auto-halt, reentrancy guard).
- `contracts/src/SimplePool.sol` — minimal constant-product pool (QOR ↔ one
  ERC-20), 0.3% fee, written from the AMM spec.
- `contracts/src/TestToken.sol` — minimal ERC-20 demo token (QAT). No value.
- `agent/` — the off-chain agent (`run-agent.mjs`, `decision.mjs`,
  `export-audit-log.mjs`) plus unit tests.
- `app/` — dashboard scaffolded from `create-qorechain-dapp` (viem-wagmi):
  vault status, live pool prices, on-chain trade history, owner controls.

## The AMM finding (read this before assuming x/amm)

The native AMM `x/amm` was verified live (see `AMM-RESEARCH.md`) — but it is
**Cosmos-lane only**: swaps are Cosmos messages (`MsgSwapExactIn`) signed with
a hybrid post-quantum signature, and there is **no EVM → x/amm path** (no AMM
precompile; the cross-VM precompile reaches CosmWasm contracts only). An EVM
vault therefore cannot execute an `x/amm` swap, and a Cosmos-lane swap signed
directly by the agent would bypass every vault limit. The testnet has 5 live
`x/amm` pools; the devnet has **zero** pools. The dashboard's QoreSwap EVM
contract has no published address.

So the arbitrage runs against **EVM pool contracts deployed by us on the
devnet** (`SimplePool.sol`, same `x*y=k` curve and 0.3% fee as `x/amm`
`constant_product`), seeded at divergent prices. This is fully disclosed, and
every demo trade is a real on-chain tx with a receipt — nothing is faked.
The vault is target-agnostic: on testnet it could target the QoreSwap
contract once QoreChain publishes its address, or any other EVM pool.

## Devnet deployment (current: v2)

Network: `qorechain-devnet`, EVM JSON-RPC `http://localhost:8545`,
chain id 9800. Deployed 2026-11-16 ~02:35 WIB (19:35 UTC 2026-11-15).

| Contract | Address |
|---|---|
| AgentVault (v2) | `0x62FF92C2B8bB701A17419f6ddCD734A15d8D4b78` |
| SimplePool A (QAT cheap) | `0xD2333ADb338F1E8dD2C494c24731d47ae252d625` |
| SimplePool B (QAT expensive) | `0x9676EB13C598A5afA2b59182c7C1446C2c781a5c` |
| TestToken (QAT) | `0xAB5A98f22323981Cca77a3289c78D834cf6Ae5D9` |

- Owner: `0x921aCe4320B694F166923C549338560f24cacf36`
  (`qor1jgdvuseqk620ze5j832fxwzkpujv4nekrm9r48`, key `ag-owner`)
- Agent: `0x8744f11f96BB62700ba6b9A2f3Dad2427E316893`
  (`qor1saz0z8ukhd38qzaxhx308kkjgflrz6ynhmanvj`, key `ag-agent`)
- Policy: maxPerTrade **0.5 QOR**, dailyLimit **2 QOR** (rolling 24h),
  authExpiry **2026-11-22 19:35 UTC** (7 days), maxConsecutiveLosses **3**.
- Pools seeded: A = 3.5 QOR / 3.85 QAT (1.10 QAT/QOR), B = 3.5 QOR /
  3.15 QAT (0.90 QAT/QOR) — a real ~20% marginal spread.
- Vault funded with 1.5 QOR (deposit tx
  `0x1bf0780a56c5be81b97ed27e3290503e24758e28fb5174ca99ced307e6b636d7`).
  Vault deploy tx `0x47afa9259fea56e50db899933eadb86be6596e328a00872bc659902c936b0d76`
  (block 14407).

A v1 deployment (vault `0xB89ceC2D658A53b9f3EfFf15BbF697CD29991263`) was
superseded by v2: v1's `receive()` emitted `Deposited` for pool refunds,
polluting the audit log; v2 accepts plain transfers silently (see Revision 2
below). V1 evidence is preserved in `agent/run-log-2026-11-15-run1.json` and
`agent/run-log-2026-11-15-run2.json`.

### E2E results on v2 (all real devnet txs)

| Run | Direction | Spread | Gross profit | Gas cost | Net | Leg txs |
|---|---|---|---|---|---|---|
| A | A→B, 0.2 QOR | 785 bps | +0.015715 QOR | 0.044311 QOR | −0.028596 QOR | `0xc97f9fb6…`, `0x32b66b9c…` |
| B | B→A, 0.02 QOR | 203 bps | +0.000407 QOR | 0.038802 QOR | −0.038396 QOR | `0xb29c71d6…`, `0x92ae6d0b…` |

(Full hashes in `agent/run-log-2026-11-15-v2-A.json` /
`run-log-2026-11-15-v2-B.json` and in the audit log.)

- **On-chain rejection:** a 0.6 QOR trade (over the 0.5 cap) reverted
  on-chain with `ExceedsPerTradeCap` — tx
  `0xcb3030b892a0bc113c544143c8b5f874a2d0c38daab7e76b56f3ed9ecc92bd2c`,
  receipt status `0x0`.
- **Local rejection:** with the daily limit temporarily lowered to 0.45 QOR
  (spent 0.4478), the agent refused to send and logged
  `leg1: exceeds daily limit; leg2: exceeds daily limit`
  (`run-log-2026-11-15-v2-rejection.json`). Policy was then restored to
  0.5 / 2 QOR (tx `0x198010993c09bce5b149d15636e672562bf0bd86b6aaea2486e0988f8b20e311`).
- **Audit log:** `agent/audit-log-2026-11-15.json` (+ `.csv`) — 7 events
  rebuilt from chain: 1 deposit, 4 trades (all profitable), 2 policy
  updates, 0 auto-halts.
- **Vault final state:** 1.516121484825813859 QOR (from 1.5), 4 trades,
  not halted, spent 0.4478 / 2 QOR in the last 24h.

**Gas honesty:** at devnet gas prices (~112.5 gwei) each vault trade costs
~171k–223k gas (~0.019–0.025 QOR per leg), so demo-scale round trips are
**gross-profitable but gas-negative**. The run log reports gross profit, gas
cost, and net profit for every round trip — nothing is hidden. With deeper
pools and larger sizes the same math turns net-positive (profit scales with
size; gas is roughly fixed per leg). This is a demo-scale limitation, not a
mechanics failure: the arbitrage, the caps, and the halts all work as
specified.

## How the agent decides

Each iteration (default 30s):

1. Read both pools' reserves and the vault state live (`eth_call`).
2. Simulate **both** directions at size (price impact + both 0.3% fees
   included) and pick the better spread.
3. If the spread exceeds the threshold (default 50 bps = 0.5%), mirror every
   on-chain gate locally (per-trade cap, rolling daily budget, allowlist,
   expiry, halted, vault balance) for **both** legs; log and skip on any
   failure.
4. Execute leg 1 (buy QAT on the cheap pool) through the vault, re-quote leg
   2 from fresh reserves and the actual QAT held, execute leg 2 (sell QAT on
   the expensive pool).
5. Record hashes, P&L, and gas to the run log. Stop itself when the vault is
   halted, authorisation expires, the daily budget is exhausted, or the run
   limits (`--max-trades`, `--duration-minutes`) are reached.

One subtlety the first run taught us: a round trip **moves the pools** — after
run 1 the spread flipped from +785 bps (A→B) to −1393 bps, so a one-direction
agent would sit idle while the reverse direction was profitable. The agent
therefore trades both directions (Revision 1).

### P&L accounting (on-chain)

`executeTrade` decodes the target's returned `uint256` as `valueOut` and
records `pnl = valueOut − valueIn` in raw units; a trade counts as a loss iff
`valueOut < valueIn`. This is meaningful when the legs are near parity (the
demo pools are seeded near 1 QOR = 1 QAT) and acts as a conservative safety
tripwire for the auto-halt — not as a pricing oracle. The off-chain run log
additionally records true QOR-denominated gross/net P&L per round trip.

### The QOR passthrough (why the pool refunds)

The vault's `executeTrade(target, data, valueIn, minOut)` attaches `valueIn`
QOR to every call — its single accounting parameter. On a token-sell leg that
QOR is not spent, so `SimplePool.swapTokenForQor` refunds any attached QOR
in full. This keeps the vault's interface exact while letting one parameter
express both legs. The sell leg's QAT amount is still counted against the
per-trade and daily caps (the agent sizes the buy so the QAT received fits
the cap — see `fitBuySize`).

## Authenticated messaging

- **Policy changes are owner-only on-chain calls.** `setPolicy`,
  `addTarget`/`removeTarget`, `setAgent`, `halt`/`resume`, `withdraw`, and
  `approveToken` all require `msg.sender == owner`. There is no off-chain
  admin channel and no API key that can change policy — the chain is the
  authentication.
- **Trades are agent-only on-chain calls.** `executeTrade` requires
  `msg.sender == agent` (the address registered in the vault). The off-chain
  agent signs every trade with the agent account's EVM key; the vault
  rejects trades from any other sender, including the owner.
- **The agent's power is minimal by construction.** It cannot change policy,
  withdraw, approve tokens, or call non-allowlisted targets — enforced by
  the contract, tested in Foundry (including an agent-as-attacker
  reentrancy test).
- **Post-quantum gate (QoreChain-native).** Every EVM transaction on
  QoreChain additionally requires the sending account to hold a registered
  ML-DSA-87 key and an open EVM authorisation window (bounded blocks / txs /
  value). The deployer and agent accounts used here both have registered
  Dilithium-5 keys and open windows (see Deploy below). This is a chain-level
  property, not something this entry re-implements.

## Run it

### Prerequisites

- Foundry (`forge`, `cast`) — binaries in `~/workspace/tools/foundry/bin`
  on the build VM, or any Foundry 1.9+ install.
- Node.js 20+ and npm.
- A running QoreChain devnet (`qorechain-devnet`, Cosmos RPC
  `http://localhost:26657`, EVM RPC `http://localhost:8545`), or the
  public testnet (`https://evm-testnet.qore.host`, chain id 9800).

### 1. Contracts — build & test

```bash
cd contracts
forge build
forge test        # 32 tests, all must pass
```

### 2. Agent — install, test, run

```bash
cd agent
npm install
npm test          # 27 unit tests (node:test), all must pass
cp .env.example .env   # fill VAULT_ADDRESS, POOL_A, POOL_B, TOKEN_ADDRESS,
                       # FROM_BLOCK and AGENT_PRIVATE_KEY (devnet key only;
                       # .env is git-ignored and NEVER committed)
node run-agent.mjs --max-trades 4 --duration-minutes 10 --interval-seconds 30
node export-audit-log.mjs   # rebuilds audit-log-<date>.json + .csv from chain
```

Dry-run first if you like: `node run-agent.mjs --dry-run --max-trades 1
--duration-minutes 0.2` observes and decides without sending txs.

### 3. Dashboard

```bash
cd app
cp .env.example .env   # VITE_USE_DEVNET=true for the local devnet
npm install            # ~11 min on first run
npm run build          # must exit 0
npm run dev            # http://localhost:5173 — HTTP 200
```

The dashboard shows vault status (balance, halted/active, authorisation
countdown, caps spent/left, loss streak), live pool prices, trade history
rebuilt from `TradeExecuted` events, and owner controls (halt/resume, policy,
agent, withdraw, deposit). It explains the EVM-window requirement honestly:
without an open window, the chain refuses every EVM action.

## Deploy (devnet)

```bash
# 0. The deployer needs >= 9.5 QOR (7 seed + 1.5 deposit + ~1 gas buffer)
#    and a registered ML-DSA-87 key + open EVM window:
qorechaind tx pqc gen-key <name>
qorechaind tx pqc register-key-v2 dilithium5 <pubkey-hex> hybrid \
  --from <key> --pqc-key <name> --chain-id qorechain-devnet \
  --fees 60000uqor --gas 400000 --yes
qorechaind tx pqc open-evm-window 3600 30 25qor --from <key> \
  --generate-only ... > window.json
qorechaind tx pqc cosign window.json --from <key> --pqc-key <name> \
  --chain-id qorechain-devnet --fees 60000uqor --gas 400000 --yes
#    (wait ~10s after opening: the account nonce advances)

# 1. Deploy + seed + fund (AGENT_ADDRESS = agent EOA, OWNER_PRIVATE_KEY = deployer)
cd contracts
AGENT_ADDRESS=0x... OWNER_PRIVATE_KEY=0x... forge script script/Deploy.s.sol \
  --rpc-url http://localhost:8545 --broadcast
```

The deploy script deploys token + 2 pools + vault, allowlists the pools,
approves the vault's QAT for both pools, seeds the pools at 1.10 / 0.90
QAT per QOR, and deposits 1.5 QOR. It fails fast if the deployer holds
under 9.5 QOR (a v2 lesson: without the check, forge broadcast the early
txs and silently dropped the deposit when the deployer ran dry).

The agent account needs its own ML-DSA-87 key + EVM window before it can
send trades (same flow as above, with the agent key).

### Testnet — DEPLOYED 16 Nov 2026

Same contracts and scripts with `--rpc-url https://evm-testnet.qore.host`.
Testnet has 5 live `x/amm` pools, but — as established above — the vault
cannot call them; the demo pools were deployed (or target the QoreSwap
contract once its address is published). Testnet QOR comes from the faucet;
the EVM window flow is identical.

| Contract | Address (testnet `qorechain-diana`, EVM 9800) |
|---|---|
| AgentVault | `0xA01b8312637dc1119bCAd5f1A8ECF257957fE128` (9,841 bytes code) |
| SimplePool A (QAT cheap) | `0x9956A21D78E24f7dC95046e320Bd327495633183` (3.5 QOR seeded) |
| SimplePool B (QAT expensive) | `0x98de011D75dfee841B3D8D2239BbAfEbc322835C` (3.5 QOR seeded) |
| TestToken (QAT) | `0xB0d9CC87c4164E3f673476Bf354F00242c620514` |

- Owner: `0x4ebF42bc963A290EC0c50549ddE011D479723F6b` (deployer,
  `qor1f6l590yk8g5sasx9q4yamcq363uhy0mtp0lhk6`); agent:
  `0xb1e8cd05fbe52401a2113ed4c2ada19c0c414033`
  (`qor1k85v6p0mu5jqrgs38m2v9tdpnsxyzspnzqtjzd`).
- Policy: maxPerTrade **0.5 QOR**, dailyLimit **2 QOR**, authExpiry **7 days
  from deploy (~23 Nov 2026)**, maxConsecutiveLosses **3**.
- All 13 deploy txs status 1 in block 10154126 (vault deploy tx
  `0xabbc47888e7e152b4a4be09229d20abe708d36345fbaad04149147adf652f909`).
- Agent run on testnet (`agent/run-log-2026-11-16-testnet.json`): spread
  785bps A→B, 1 round trip — leg1 `0x2a710c0fe9c3807b1268e39f7f7b385c4c5c48bc265e68cbb3cb59d65f322461`
  (0.2 QOR → 0.2075 QAT), leg2 `0x502ee2ca188ed1778bb6c8e47c7982ce635a91d17418ea43afd5621822d66dce`
  (→ 0.2157 QOR); gross +0.0157 QOR, gas 0.0443 QOR, net −0.0286 QOR.
  Rejection: 0.6 QOR trade (above the 0.5 QOR cap) status 0
  (`0x154564787a667ecf65290cae60d47adefbbcfb216dfd8a2696897d65c3fb7fc8`).
- Deploy notes: `Deploy.s.sol` had a compile bug (`uint256 deployer =
  vm.addr(...)` — vm.addr returns address), fixed 16 Nov 2026; the script
  needs `--gas-limit 15000000` (3M OOGs on the 15-tx simulation).
- Full evidence: `../TESTNET-DEPLOY-LOG.md`.

## Revisions (what the live runs changed)

1. **Two-way arbitrage + gas accounting (agent).** Run 1's round trip
   flipped the spread (+785 → −1393 bps); the agent now simulates both
   directions and trades the better one, and every round trip logs gross
   profit, gas cost, and net profit from receipts. Verified by run B
   (B→A, 203 bps) and 4 new unit tests.
2. **Silent `receive()` (vault).** V1 emitted `Deposited` for pool refunds,
   polluting the audit log. V2 accepts plain transfers silently; only the
   explicit `deposit()` emits. Locked in by a Foundry test asserting no
   `Deposited` event on a plain transfer. Required a redeploy (v2).
3. **Deploy-script funding guard.** Fails fast below 9.5 QOR instead of a
   half-deploy with a silently dropped deposit (observed on the v2 deploy;
   the deposit was then made separately, tx `0x1bf0780a…`).

## Known limitations

- **Demo pools, demo scale.** The pools are ours, seeded by us, with 3.5 QOR
  each. Spreads are real and trades are real, but depth is tiny: a 0.2 QOR
  trade is ~6% of reserves, so price impact dominates and one round trip
  nearly closes the spread.
- **Gas-negative at demo scale** (see E2E results). Net-positive needs
  deeper pools / larger sizes.
- **Two pools, one pair.** The agent arbitrages one QOR/QAT pair across two
  pools. Multi-pair / multi-pool routing is future work.
- **No testnet deployment yet.** Devnet only; the testnet path is documented
  above but not executed.
- **P&L tripwire is parity-based** (see P&L accounting). For pairs far from
  parity the on-chain loss counter needs a price-aware design.
- **The agent holds a hot EVM key** (from `.env` at runtime). The vault caps
  the damage a stolen agent key can do (per-trade + daily caps, allowlist,
  expiry, auto-halt), but key management (e.g. rotation, HSM) is out of scope
  for this demo.
- **Authorisation expires 2026-11-22 19:35 UTC** on the current deployment;
  the owner must call `setPolicy` with a new expiry (or redeploy) to keep the
  agent running past then.

## Files

- `README.md` (this file), `AMM-RESEARCH.md` (x/amm verification),
  `AI_USAGE.md` (honest AI-workflow disclosure), `LICENSE` (MIT),
  `.gitignore`
- `contracts/` — Foundry project: `src/AgentVault.sol`,
  `src/SimplePool.sol`, `src/TestToken.sol`, `test/`, `script/Deploy.s.sol`
- `agent/` — `run-agent.mjs`, `decision.mjs`, `decision.test.mjs`,
  `export-audit-log.mjs`, `abis.mjs`, `config.mjs`, `.env.example`,
  run logs + audit logs (git-ignored artifacts of the demo runs)
- `app/` — dashboard (RainbowKit + wagmi + viem scaffold, customised)

## Credits

- Template: `create-qorechain-dapp` (viem-wagmi template) + QoreChain SDK
  (`@qorechain/evm`, `@qorechain/qorex-rainbowkit`).
- Tooling: Foundry, viem, wagmi, RainbowKit.
- AMM curve/fee reference: QoreChain docs (`x/amm`, `swap_fee_bps: 30`) and
  the public `qorechain-core` repo (message interfaces only).
- All contract and agent code was written fresh for this entry from the
  behavioural specification; no other project's code was copied.
