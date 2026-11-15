// Minimal ABIs for the dashboard, matching contracts/src/*.sol and
// agent/abis.mjs. Kept in sync by hand; the contracts are small and stable.
export const vaultAbi = [
  {
    type: "function",
    name: "executeTrade",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "valueIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "halt",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "resume",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPolicy",
    inputs: [
      { name: "maxPerTrade_", type: "uint256" },
      { name: "dailyLimit_", type: "uint256" },
      { name: "authExpiry_", type: "uint256" },
      { name: "maxConsecutiveLosses_", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAgent",
    inputs: [{ name: "agent_", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "agent", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "maxPerTrade", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "dailyLimit", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "authExpiry", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "maxConsecutiveLosses",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "consecutiveLosses",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "tradeCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "halted", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "spentLast24h", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balance", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "tokenBalance",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "TradeExecuted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "valueIn", type: "uint256", indexed: false },
      { name: "valueOut", type: "uint256", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
      { name: "profitable", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AutoHalted",
    inputs: [{ name: "reason", type: "string", indexed: false }],
  },
] as const;

export const poolAbi = [
  {
    type: "function",
    name: "getReserves",
    inputs: [],
    outputs: [
      { name: "qor", type: "uint256" },
      { name: "tokenAmount", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "priceTokenPerQor",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;
