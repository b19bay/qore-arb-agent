# AI Usage — honest disclosure (Best AI-Native Build)

This entry was built with an AI-native workflow: an AI agent (Muse) wrote
the code, ran the tests, deployed the contracts, and operated the agent runs
— under a human-written behavioural specification and with every on-chain
claim verified from real receipts. Nothing in this file is a boast; it is a
record of what the AI did, what it did not do, and where the human stayed in
the loop.

## What the AI did

- **Wrote all code fresh from the specification** (`SPEC.md`, human-written):
  `AgentVault.sol`, `SimplePool.sol`, `TestToken.sol`, the Foundry test
  suite (32 tests), the off-chain agent (`run-agent.mjs`, `decision.mjs`,
  `export-audit-log.mjs`), the agent unit tests (27 tests), and the
  dashboard customisation on top of the `create-qorechain-dapp` scaffold.
  No code was copied from other projects; the only external code read was
  the QoreChain docs and the public `qorechain-core` repo's `x/amm`
  message interfaces (for the AMM verification).
- **Verified the AMM interface first**, as the spec required: live queries
  against the devnet and testnet, docs, and the public repo — concluding
  that `x/amm` is Cosmos-lane only and cannot be called from an EVM vault
  (documented in `AMM-RESEARCH.md`). The pivot-to-demo-pools decision was
  the AI's judgement call under the spec's rules, documented with evidence.
- **Ran the full E2E flow**: generated PQC keys, registered them on-chain,
  opened EVM windows, exported devnet test keys to mode-0600 files (never
  printed, never committed), deployed via Foundry, ran the agent, exported
  the audit log, and verified every step from receipts and `query tx`
  (DeliverTx code), not from broadcast codes.
- **Revised from live evidence, twice:**
  1. Run 1's round trip flipped the spread (+785 → −1393 bps), leaving a
     one-direction agent idle. The AI generalised the agent to two-way
     arbitrage and added per-leg gas accounting from receipts — then
     re-ran all tests and verified the revision with a real reverse-
     direction trade (run B, B→A, 203 bps).
  2. The v1 audit log showed pool refunds mislabelled as deposits. The AI
     traced it to `receive()` emitting `Deposited`, fixed the contract,
     added a regression test, and redeployed (v2) with a clean audit log.
  3. The v2 deploy's deposit step silently failed to broadcast when the
     deployer ran short of funds; the AI added a fail-fast funding guard
     to the deploy script and documented the separate deposit tx.

## What the AI did NOT do

- **No trade, price, or test result was invented.** Every number in the
  README comes from a real run: Foundry output, `node --test` output,
  `npm run build` output, or an on-chain receipt. Where the results are
  unflattering (round trips are gas-negative at demo scale), they are
  reported as-is with the arithmetic shown.
- **No mainnet, no real funds, no paid services.** Devnet only
  (`qorechain-devnet`), test keys only.
- **No credentials in any file.** Keys live in `.env` (git-ignored, mode
  0600) and in `/tmp` mode-0600 files used only at runtime; the repo
  contains only `.env.example` files with placeholder/public values.
- **No silent scope changes.** The AMM decision, the QOR-passthrough
  design, the parity-based P&L tripwire, and the gas-negative result are
  all documented in the README/AMM-RESEARCH.md rather than hidden.

## Where the human stayed in the loop

- The human wrote the behavioural specification (`SPEC.md`) that defined
  the vault's gates, the agent's loop, the test list, and the file list —
  including the hard rules (fresh-write only, no mainnet, no faked trades,
  mandatory revision).
- The human owns the devnet accounts and the final submission; the AI
  operated the devnet test keys only for this entry's deployment and runs.
- The human reviews this handoff and decides what ships.

## Tools the AI used

- Foundry (`forge`, `cast`) for contracts, tests, deployment.
- Node.js + viem for the agent; `node:test` for agent unit tests.
- `qorechaind` CLI for PQC key management, EVM windows, and chain queries.
- `create-qorechain-dapp` + npm for the dashboard scaffold.
- Web search + `browser.open` for docs verification (docs.qorechain.io).
