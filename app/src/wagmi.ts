import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { qorechain, qorechainTestnet } from "@qorechain/evm";
import { qorexWallet } from "@qorechain/qorex-rainbowkit";
import { defineChain } from "viem";
import { createConfig, http } from "wagmi";

import { DEVNET_RPC, USE_DEVNET } from "./config.js";

// QoreX first, then any other injected (EIP-1193) wallet. Neither uses
// WalletConnect, so the project id is only a placeholder unless you add a
// WalletConnect-based wallet.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [() => qorexWallet({ pollAccountsOnFocus: true }), injectedWallet],
    },
  ],
  {
    appName: "Qore Arb Agent",
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "unused",
  },
);

// The local devnet shares the testnet's EVM chain id (9800), so wagmi can
// only list one of them at a time. VITE_USE_DEVNET=true swaps the testnet
// transport for the local node (default http://localhost:8545).
export const qorechainDevnet = defineChain({
  id: 9800,
  name: "QoreChain Devnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [DEVNET_RPC] } },
});

export const config = createConfig({
  chains: USE_DEVNET ? [qorechainDevnet] : [qorechainTestnet, qorechain],
  connectors,
  // Transports are keyed by chain id for both networks; only the chains
  // listed above are usable. In devnet mode id 9800 points at the local node.
  transports: {
    [qorechainTestnet.id]: http(USE_DEVNET ? DEVNET_RPC : undefined),
    [qorechain.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
