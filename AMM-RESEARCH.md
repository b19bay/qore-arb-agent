# AMM Research — QoreChain `x/amm` verification (mandatory first step)

**Date:** 2026-11-16 (WIB)
**Question:** can the on-chain vault (`AgentVault.sol`, an EVM contract) execute
arbitrage trades against QoreChain's native AMM, `x/amm`?
**Answer: NO — not from an EVM contract.** `x/amm` is verified live, but it is
**Cosmos-lane only**: swaps are Cosmos SDK messages signed with a hybrid
post-quantum signature, and there is **no EVM → `x/amm` path** (no AMM
precompile; the cross-VM precompile reaches CosmWasm contracts only). An EVM
vault therefore cannot call `x/amm` in the same transaction, and a Cosmos-lane
swap signed directly by the agent account would bypass every on-chain vault
limit — defeating the entire point of this entry.

**Decision (documented, not a silent pivot):** the arbitrage entry proceeds
against **EVM constant-product pool contracts deployed by us on the devnet**
(`SimplePool.sol`, same `x*y=k` curve and 0.3% fee as `x/amm`
`constant_product`, see `contracts/src/SimplePool.sol`). Two pools for the
same QOR/TEST pair are seeded at different prices, the agent reads both prices
live via `eth_call`, and executes real on-chain arbitrage legs through the
vault. This is the scenario the SPEC's inoculation explicitly sanctions
("buat divergensi harga sendiri dengan trade testnet/devnet, lalu agen
mengeksekusi"). This is NOT a DCA pivot: the DCA fallback needs an EVM
pool/token target too, which equally does not exist on the devnet — pivoting
would change the strategy without fixing the missing target. All demo pools
are disclosed as ours in the README; no trade is faked — every demo trade is
a real devnet tx with a receipt.

## 1. What `x/amm` is (docs + public repo)

- Source: docs.qorechain.io/architecture/amm/ ("AMM & On-Chain Liquidity")
  and the PUBLIC repo github.com/qorechain/qorechain-core, `x/amm`
  (cloned to /tmp for this check only; the local audit copy was NOT read).
- `x/amm` is QoreChain's native on-chain AMM. Curves: `constant_product`
  (`x*y=k`) and `stable_swap` (amplification coefficient).
- Swaps are Cosmos messages (from `x/amm/types/tx.pb.go`):
  - `MsgSwapExactIn{Sender, PoolID, TokenIn, DenomOut, MinOut}` —
    sender is a bech32 `qor1...` address.
  - `MsgSwapExactOut{Sender, PoolID, DenomIn, TokenOut, MaxIn}`.
  - Also `MsgCreatePool`, `MsgAddLiquidity`, `MsgRemoveLiquidity`,
    `MsgPausePool`, `MsgResumePool`.
- CLI: `qorechaind tx amm swap-exact-in <pool_id> <token_in> <denom_out>
  <min_out>` / `swap-exact-out ...` — every `tx amm` command is a
  Cosmos-lane tx needing the hybrid PQC signature (`--generate-only`, then
  `tx pqc cosign`).
- Reads: `qorechaind query amm pools|pool|pool-by-denoms|quote-exact-in|
  quote-exact-out|params`, or REST `GET /qorechain/amm/v1/...` on
  `https://api-testnet.qore.host` (devnet REST :1317 is NOT active; CLI/RPC
  only on devnet).

## 2. Live state (checked 2026-11-16 ~02:15 WIB)

### Devnet (`qorechain-devnet`, localhost:26657) — module live, ZERO pools

```
$ qorechaind query amm params --node http://localhost:26657 --output json
{"params":{"swap_fee_bps":30,"protocol_fee_bps":10,"min_liquidity":"1000",
"max_pools_per_creator":50,"lp_token_decimals":6,
"pool_creation_fee":"100000000","max_swap_impact_bps":500,"enabled":true}}

$ qorechaind query amm pools --node http://localhost:26657 --output json
{"pools":[]}
```

Devnet has only `uqor` as a bank denom, so creating a pool there would first
require deploying an ERC-20, converting it with `MsgConvertERC20`, then
`create-pool` — and the resulting swap would still be a Cosmos-lane tx that
bypasses the EVM vault. Not pursued: it cannot serve the vault design.

### Testnet (`qorechain-diana`) — FIVE live pools (docs are stale: they say 1)

```
$ curl -s 'https://api-testnet.qore.host/qorechain/amm/v1/pools'
{"pools":[
 {"id":"1","pool_type":"constant_product","token_a":"erc20:0x02292293c13880a26242690eb70a0e42B8E91c28","token_b":"uqor","reserve_a":"979164","reserve_b":"1021369",...},
 {"id":"2","pool_type":"constant_product","token_a":"erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA","token_b":"uqor","reserve_a":"607597293","reserve_b":"7462318734",...},
 {"id":"3","pool_type":"constant_product","token_a":"erc20:0x02292293...","token_b":"erc20:0x97143B77...",...},
 {"id":"4","pool_type":"constant_product","token_a":"erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A","token_b":"uqor",...},
 {"id":"5","pool_type":"constant_product","token_a":"erc20:0x4604e7E4...","token_b":"erc20:0x97143B77...","reserve_a":"1000","reserve_b":"1000",...}]}
```

All five are `constant_product`, all pair `uqor` and/or Fest test-token
denoms `erc20:0x...` (fUSD/fETH/fBTC, testnet only, no value). Testnet params
are identical to devnet (`swap_fee_bps: 30`, `pool_creation_fee: 100000000`
uqor = 100 QOR, `max_swap_impact_bps: 500`, `enabled: true`).

## 3. Why the EVM vault cannot use `x/amm`

1. **No AMM precompile.** QoreChain's custom EVM precompiles (docs:
   "EVM Precompiles" — six total) expose PQC Verify, PQC Key Status, PRISM
   consensus params, cross-VM messaging, and AI risk scoring. None of them
   routes an EVM call into `x/amm`.
2. **Cross-VM precompile is not a bridge to `x/amm`.** The precompile at
   `0x0000000000000000000000000000000000000901` routes EVM calls to
   **QoreChain Native (CosmWasm) contracts only**, allowlisted, and only on
   testnet (not active on mainnet; docs "Multi-VM (cross-VM calls)" /
   "Cross-VM Interoperability"). There is no CosmWasm AMM contract, and
   `x/amm` is a Cosmos SDK module, not a CosmWasm contract.
3. **Cosmos-lane swaps bypass the vault.** A swap is `MsgSwapExactIn` signed
   by the agent's Cosmos key. The vault (an EVM contract) cannot observe,
   cap, or halt it. Executing arbitrage that way would leave the entry's core
   claim — "all limits enforced on-chain by the vault" — false.
4. **QoreSwap (testnet EVM DEX) has no published address.** The dashboard
   Trade page (docs.qorechain.io/dashboard/trade/) says on-chain swaps for
   WQOR/QUSDC/QUSDT/QWETH/QWBTC run against "the QoreSwap AMM contract on the
   testnet EVM (chain ID 9800)" via `swapExactTokensForTokens` with quotes
   from `getAmountOut` — but **no contract address or ABI is published in
   the docs**, so it cannot be targeted from the vault without an
   undocumented address (and it does not exist on the devnet at all, so the
   E2E demo could not use it anyway).

## 4. What the entry does instead (disclosed design)

- `contracts/src/SimplePool.sol`: a minimal constant-product pool
  (QOR native ↔ one ERC-20), `x*y=k`, 0.3% swap fee — the same curve and
  fee as `x/amm` `constant_product` (`swap_fee_bps: 30`). Written from the
  AMM spec above, not copied from any existing DEX.
- `contracts/src/TestToken.sol`: a minimal ERC-20 demo token (QAT) used only
  as the second side of the demo pools. No value; devnet only.
- Devnet E2E: deploy token + two pools, seed pool A at ~1 QOR = 1.10 QAT
  (QAT cheap) and pool B at ~1 QOR = 0.90 QAT (QAT expensive), i.e. a real
  ~20% cross-pool spread. The agent buys QAT cheap on A through the vault,
  sells it dear on B through the vault — two real on-chain legs, both
  gated by the vault's caps, allowlist, auth window, and auto-halt.
- The agent reads prices live from the pools (`getReserves` /
  `getAmountOut` via `eth_call`); no price is invented.
- Testnet path (future work, not claimed as done): the same vault can target
  the QoreSwap contract once QoreChain publishes its address/ABI, or any
  other EVM pool contract — the vault is target-agnostic (allowlist-gated
  `address.call`).

## 5. Sources

- https://docs.qorechain.io/architecture/amm/
- https://docs.qorechain.io/dashboard/trade/
- https://docs.qorechain.io/developer-guide/cross-vm-interoperability/
- https://docs.qorechain.io/rollups/multi-vm/
- https://docs.qorechain.io/api-reference/rest-grpc-endpoints/
- https://github.com/qorechain/qorechain-core (PUBLIC repo, `x/amm` only:
  `types/msgs.go`, `types/tx.pb.go`)
- Live queries above (devnet CLI + testnet REST), 2026-11-16 ~02:15 WIB.
