// Dashboard configuration. Defaults point at the devnet deployment from the
// E2E run (see README); override with VITE_* env vars for another deploy.
export const USE_DEVNET = import.meta.env.VITE_USE_DEVNET === "true";

export const VAULT_ADDRESS = (import.meta.env.VITE_VAULT_ADDRESS ??
  "0x62FF92C2B8bB701A17419f6ddCD734A15d8D4b78") as `0x${string}`;
export const POOL_A = (import.meta.env.VITE_POOL_A ??
  "0xD2333ADb338F1E8dD2C494c24731d47ae252d625") as `0x${string}`;
export const POOL_B = (import.meta.env.VITE_POOL_B ??
  "0x9676EB13C598A5afA2b59182c7C1446C2c781a5c") as `0x${string}`;
export const TOKEN_ADDRESS = (import.meta.env.VITE_TOKEN_ADDRESS ??
  "0xAB5A98f22323981Cca77a3289c78D834cf6Ae5D9") as `0x${string}`;

// First block to scan for vault events (vault deploy block on the devnet).
export const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? "14407");

export const DEVNET_RPC = import.meta.env.VITE_DEVNET_RPC ?? "http://localhost:8545";
