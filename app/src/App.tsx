import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  QORECHAIN_REST_ENDPOINTS,
  classifyEvmWindowRejection,
  qorechainTestnet,
  evmWindowStatus,
  type EvmWindowRejection,
} from "@qorechain/evm";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatEther, parseAbiItem, parseEther } from "viem";
import {
  useAccount,
  useBalance,
  useBlockNumber,
  usePublicClient,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { poolAbi, vaultAbi } from "./abi.js";
import { FROM_BLOCK, POOL_A, POOL_B, TOKEN_ADDRESS, USE_DEVNET, VAULT_ADDRESS } from "./config.js";

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key": "This account has no registered ML-DSA-87 key. Register one on the native lane first.",
  "no-window": "No EVM authorisation window is open. Open one on the native lane, then retry.",
  exhausted: "The window has run out of blocks, transactions or value. Open a new one.",
  invalid: "The chain refused the window parameters.",
};

const TRADE_EVENT = parseAbiItem(
  "event TradeExecuted(uint256 indexed id, address indexed target, uint256 valueIn, uint256 valueOut, int256 pnl, bool profitable)",
);
const HALT_EVENT = parseAbiItem("event AutoHalted(string reason)");

const REST_PROXY: Record<number, string | undefined> = Object.fromEntries(
  Object.keys(QORECHAIN_REST_ENDPOINTS).map((id) => [
    Number(id),
    Number(id) === qorechainTestnet.id ? "/lcd-testnet" : "/lcd-mainnet",
  ]),
);

/** The account's EVM authorisation window, read over the native-lane REST API. */
function WindowStatus({ address, chainId }: { address: `0x${string}`; chainId: number }) {
  const rest = REST_PROXY[chainId];
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", chainId, address],
    queryFn: () => evmWindowStatus({ rest: rest!, address }),
    enabled: rest !== undefined && !USE_DEVNET,
    refetchInterval: 10_000,
  });
  if (USE_DEVNET) {
    return (
      <p>
        EVM window: the devnet has no REST endpoint, so the window cannot be read from the browser.
        Check it with <code>qorechaind query pqc evm-window &lt;address&gt;</code>. Every EVM action
        below still needs an open window.
      </p>
    );
  }
  if (!rest) return <p>Unknown network.</p>;
  if (isLoading) return <p>Reading the EVM window...</p>;
  if (error) return <p>Could not read the window: {error.message}</p>;
  if (!data?.found) {
    return <p>EVM window: none. Sending from this account is refused until one is opened.</p>;
  }
  return (
    <p>
      EVM window: {data.live ? "live" : "not usable"} ({data.remainingBlocks.toString()} blocks,{" "}
      {data.remainingTxs.toString()} transactions, {data.remainingValue.toString()} uqor left)
    </p>
  );
}

function fmtQor(v: bigint | undefined) {
  return v === undefined ? "..." : `${formatEther(v)} QOR`;
}

function fmtCountdown(expiry: bigint | undefined) {
  if (expiry === undefined) return "...";
  const secs = Number(expiry) - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "EXPIRED";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${d}d ${h}h ${m}m left (until ${new Date(Number(expiry) * 1000).toLocaleString()})`;
}

function VaultStatus() {
  const { data, isLoading, error } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "owner" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "agent" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "balance" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "halted" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "authExpiry" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "maxPerTrade" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "dailyLimit" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "spentLast24h" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "consecutiveLosses" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "maxConsecutiveLosses" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "tradeCount" },
      { address: VAULT_ADDRESS, abi: vaultAbi, functionName: "tokenBalance", args: [TOKEN_ADDRESS] },
      { address: POOL_A, abi: poolAbi, functionName: "getReserves" },
      { address: POOL_B, abi: poolAbi, functionName: "getReserves" },
      { address: POOL_A, abi: poolAbi, functionName: "priceTokenPerQor" },
      { address: POOL_B, abi: poolAbi, functionName: "priceTokenPerQor" },
    ],
    query: { refetchInterval: 10_000 },
  });
  if (isLoading) return <p>Reading the vault...</p>;
  if (error) return <p>Could not read the vault: {error.message}</p>;
  const r = (i: number) => data?.[i]?.result as never;
  const [owner, agent, balance, halted, authExpiry, maxPerTrade, dailyLimit, spent24h, losses, maxLosses, tradeCount, qatBalance, resA, resB, priceA, priceB] = [
    r(0) as `0x${string}`,
    r(1) as `0x${string}`,
    r(2) as bigint,
    r(3) as boolean,
    r(4) as bigint,
    r(5) as bigint,
    r(6) as bigint,
    r(7) as bigint,
    r(8) as bigint,
    r(9) as bigint,
    r(10) as bigint,
    r(11) as bigint,
    r(12) as readonly [bigint, bigint],
    r(13) as readonly [bigint, bigint],
    r(14) as bigint,
    r(15) as bigint,
  ];
  const dailyLeft = dailyLimit !== undefined && spent24h !== undefined ? dailyLimit - spent24h : undefined;
  return (
    <section>
      <h2>Vault status</h2>
      <p>
        Vault <code>{VAULT_ADDRESS}</code>
      </p>
      <ul>
        <li>
          Status: <strong>{halted ? "HALTED" : "active"}</strong>
        </li>
        <li>Balance: {fmtQor(balance)} (+ {fmtQor(qatBalance)} QAT held)</li>
        <li>Owner: <code>{owner}</code></li>
        <li>Agent: <code>{agent}</code></li>
        <li>Authorisation: {fmtCountdown(authExpiry)}</li>
        <li>Per-trade cap: {fmtQor(maxPerTrade)}</li>
        <li>
          Daily cap: {fmtQor(dailyLimit)} — spent (24h rolling): {fmtQor(spent24h)} — left:{" "}
          {fmtQor(dailyLeft)}
        </li>
        <li>
          Consecutive losses: {losses?.toString()} / {maxLosses?.toString()} (auto-halt)
        </li>
        <li>Trades executed: {tradeCount?.toString()}</li>
      </ul>
      <h3>Pools (live prices)</h3>
      <ul>
        <li>
          Pool A <code>{POOL_A}</code>: {fmtQor(resA?.[0])} / {fmtQor(resA?.[1])} QAT —{" "}
          {priceA !== undefined ? `${formatEther(priceA)} QAT per QOR` : "..."}
        </li>
        <li>
          Pool B <code>{POOL_B}</code>: {fmtQor(resB?.[0])} / {fmtQor(resB?.[1])} QAT —{" "}
          {priceB !== undefined ? `${formatEther(priceB)} QAT per QOR` : "..."}
        </li>
      </ul>
    </section>
  );
}

type TradeRow = {
  id: string;
  target: string;
  valueIn: string;
  valueOut: string;
  pnl: string;
  profitable: boolean;
  txHash: string;
  blockNumber: bigint;
  time: string;
};

function TradeHistory() {
  const publicClient = usePublicClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["trade-history", VAULT_ADDRESS],
    queryFn: async (): Promise<{ trades: TradeRow[]; halts: { reason: string; txHash: string; time: string }[] }> => {
      if (!publicClient) throw new Error("No public client");
      const [tradeLogs, haltLogs] = await Promise.all([
        publicClient.getLogs({ address: VAULT_ADDRESS, event: TRADE_EVENT, fromBlock: FROM_BLOCK, toBlock: "latest" }),
        publicClient.getLogs({ address: VAULT_ADDRESS, event: HALT_EVENT, fromBlock: FROM_BLOCK, toBlock: "latest" }),
      ]);
      const times = new Map<bigint, string>();
      const when = async (n: bigint) => {
        if (!times.has(n)) {
          const b = await publicClient.getBlock({ blockNumber: n });
          times.set(n, new Date(Number(b.timestamp) * 1000).toLocaleString());
        }
        return times.get(n)!;
      };
      const trades: TradeRow[] = [];
      for (const l of tradeLogs) {
        const a = l.args;
        trades.push({
          id: a.id!.toString(),
          target: a.target!,
          valueIn: formatEther(a.valueIn!),
          valueOut: formatEther(a.valueOut!),
          pnl: `${a.pnl! < 0n ? "-" : ""}${formatEther(a.pnl! < 0n ? -a.pnl! : a.pnl!)}`,
          profitable: a.profitable!,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          time: await when(l.blockNumber),
        });
      }
      const halts = [];
      for (const l of haltLogs) {
        halts.push({ reason: l.args.reason!, txHash: l.transactionHash, time: await when(l.blockNumber) });
      }
      return { trades: trades.reverse(), halts: halts.reverse() };
    },
    refetchInterval: 15_000,
  });
  if (isLoading) return <p>Reading trade history...</p>;
  if (error) return <p>Could not read trade history: {error.message}</p>;
  return (
    <section>
      <h2>Trade history (on-chain events)</h2>
      {data!.halts.length > 0 && (
        <p>
          Auto-halts:{" "}
          {data!.halts.map((h) => `${h.time} — ${h.reason} (${h.txHash.slice(0, 12)}…)`).join("; ")}
        </p>
      )}
      {data!.trades.length === 0 ? (
        <p>No trades yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Target</th>
              <th>In</th>
              <th>Out</th>
              <th>P&amp;L</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {data!.trades.map((t) => (
              <tr key={t.txHash + t.id}>
                <td>{t.id}</td>
                <td>{t.time}</td>
                <td>
                  <code>{t.target === POOL_A ? "Pool A" : t.target === POOL_B ? "Pool B" : `${t.target.slice(0, 10)}…`}</code>
                </td>
                <td>{t.valueIn}</td>
                <td>{t.valueOut}</td>
                <td style={{ color: t.profitable ? "green" : "red" }}>{t.pnl}</td>
                <td>
                  <code>{t.txHash.slice(0, 12)}…</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        Agent run logs: the off-chain agent writes one JSON log per run to{" "}
        <code>agent/run-log-&lt;date&gt;.json</code> in the repo (observations, decisions, tx
        hashes). The table above is rebuilt from chain events, not from agent memory.
      </p>
    </section>
  );
}

function OwnerControls({ owner }: { owner: `0x${string}` | undefined }) {
  const { address } = useAccount();
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isSuccess } = useWaitForTransactionReceipt({ hash });
  const [maxPerTrade, setMaxPerTrade] = useState("0.5");
  const [dailyLimit, setDailyLimit] = useState("2");
  const [expiryDays, setExpiryDays] = useState("7");
  const [maxLosses, setMaxLosses] = useState("3");
  const [newAgent, setNewAgent] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [depositAmount, setDepositAmount] = useState("");

  const isOwner = owner !== undefined && address !== undefined && owner.toLowerCase() === address.toLowerCase();
  const rejection = error ? classifyEvmWindowRejection(error) : undefined;

  if (!isOwner) {
    return (
      <section>
        <h2>Owner controls</h2>
        <p>Connect the owner wallet ({owner ? <code>{owner}</code> : "..."}) to manage the vault.</p>
      </section>
    );
  }
  const expiryTs = BigInt(Math.floor(Date.now() / 1000) + Number(expiryDays || 0) * 86400);
  return (
    <section>
      <h2>Owner controls</h2>
      <p>
        <button type="button" disabled={isPending} onClick={() => writeContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: "halt" })}>
          Halt vault
        </button>{" "}
        <button type="button" disabled={isPending} onClick={() => writeContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: "resume" })}>
          Resume vault
        </button>
      </p>
      <h3>Policy</h3>
      <p>
        Max/trade (QOR){" "}
        <input value={maxPerTrade} onChange={(e) => setMaxPerTrade(e.target.value)} size={6} /> Daily
        limit (QOR) <input value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} size={6} />{" "}
        Auth (days from now){" "}
        <input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} size={4} /> Max
        consecutive losses{" "}
        <input value={maxLosses} onChange={(e) => setMaxLosses(e.target.value)} size={3} />{" "}
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            writeContract({
              address: VAULT_ADDRESS,
              abi: vaultAbi,
              functionName: "setPolicy",
              args: [parseEther(maxPerTrade || "0"), parseEther(dailyLimit || "0"), expiryTs, BigInt(maxLosses || "0")],
            })
          }
        >
          Update policy
        </button>
      </p>
      <h3>Agent &amp; funds</h3>
      <p>
        New agent{" "}
        <input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} size={44} placeholder="0x…" />{" "}
        <button
          type="button"
          disabled={isPending || !newAgent.startsWith("0x")}
          onClick={() =>
            writeContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: "setAgent", args: [newAgent as `0x${string}`] })
          }
        >
          Set agent
        </button>
      </p>
      <p>
        Withdraw (QOR){" "}
        <input value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} size={8} /> to{" "}
        <input value={withdrawTo} onChange={(e) => setWithdrawTo(e.target.value)} size={44} placeholder="0x…" />{" "}
        <button
          type="button"
          disabled={isPending || !withdrawTo.startsWith("0x")}
          onClick={() =>
            writeContract({
              address: VAULT_ADDRESS,
              abi: vaultAbi,
              functionName: "withdraw",
              args: [parseEther(withdrawAmount || "0"), withdrawTo as `0x${string}`],
            })
          }
        >
          Withdraw
        </button>
      </p>
      <p>
        Deposit (QOR){" "}
        <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} size={8} />{" "}
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            writeContract({
              address: VAULT_ADDRESS,
              abi: vaultAbi,
              functionName: "deposit",
              value: parseEther(depositAmount || "0"),
            })
          }
        >
          Deposit
        </button>{" "}
        (anyone may deposit)
      </p>
      {hash && (
        <p>
          Tx: <code>{hash}</code> {isSuccess ? "— confirmed" : "— waiting for confirmation…"}
        </p>
      )}
      {error && <p>Refused: {rejection ? REMEDY[rejection] : error.message}</p>}
    </section>
  );
}

export function App() {
  const { address, chainId, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const { data: block } = useBlockNumber({ watch: true });
  const { data: owner } = useReadContracts({
    contracts: [{ address: VAULT_ADDRESS, abi: vaultAbi, functionName: "owner" }],
  });
  const ownerAddress = owner?.[0]?.result as `0x${string}` | undefined;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 860, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Qore Arb Agent — vault dashboard</h1>
      <p>
        An autonomous arbitrage agent whose every limit is enforced on-chain by the vault: per-trade
        cap, rolling 24h cap, target allowlist, authorisation expiry, and auto-halt on consecutive
        losses or budget exhaustion. All trades are settled on-chain; the history below is rebuilt
        from vault events.
      </p>
      <p>
        <strong>EVM windows:</strong> every EVM action on QoreChain needs an open authorisation
        window (ML-DSA-87 key + <code>open-evm-window</code> on the native lane). Without one, the
        chain refuses the transaction — that is the post-quantum gate, not a bug.
      </p>
      <ConnectButton />
      <p>Latest block: {block?.toString() ?? "..."}</p>

      {isConnected && address && chainId ? (
        <section>
          <p>
            Account <code>{address}</code> on chain {chainId}
            {USE_DEVNET ? " (local devnet)" : ""}
          </p>
          <p>Balance: {balance ? `${formatEther(balance.value)} QOR` : "..."}</p>
          <WindowStatus address={address} chainId={chainId} />
        </section>
      ) : (
        <p>Connect a wallet to interact. Vault state below is public and readable without a wallet.</p>
      )}

      <VaultStatus />
      <TradeHistory />
      <OwnerControls owner={ownerAddress} />
    </main>
  );
}
