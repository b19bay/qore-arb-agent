// Minimal ABIs, hand-written from contracts/src/*.sol (no codegen step).
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
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "agent", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "maxPerTrade", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "dailyLimit", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "authExpiry", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "maxConsecutiveLosses", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "consecutiveLosses", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
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
    type: "function",
    name: "isAllowed",
    inputs: [{ name: "target", type: "address" }],
    outputs: [{ type: "bool" }],
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
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "Halted", inputs: [{ name: "by", type: "address", indexed: true }] },
  { type: "event", name: "Resumed", inputs: [{ name: "by", type: "address", indexed: true }] },
  {
    type: "event",
    name: "PolicyUpdated",
    inputs: [
      { name: "maxPerTrade", type: "uint256", indexed: false },
      { name: "dailyLimit", type: "uint256", indexed: false },
      { name: "authExpiry", type: "uint256", indexed: false },
      { name: "maxConsecutiveLosses", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AgentChanged",
    inputs: [
      { name: "oldAgent", type: "address", indexed: true },
      { name: "newAgent", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
];

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
    name: "getAmountOut",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "qorIn", type: "bool" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "swapQorForToken",
    inputs: [{ name: "minOut", type: "uint256" }],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "swapTokenForQor",
    inputs: [
      { name: "tokenIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "priceTokenPerQor",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
];

export const tokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];
