"use client";

import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/useSession";

// Whitelist of wallets we actually want to surface.
//
// Without this list the adapter shows everything that announces itself via
// the AIP-62 wallet standard — including Backpack (primarily a Solana
// wallet whose Aptos support is patchy), OKX, Nightly, etc. Users were
// being offered Backpack and finding no Aptos network inside it. We also
// deliberately exclude the keyless social-login options ("Continue with
// Google" / "Continue with Apple"): they would work in principle but
// require the Aptos Keyless verification module on-chain, which Shelbynet
// (a devnet-tier, Shelby-specific network) does not appear to have today.
// Listing them would let users sign in with Google and then hit an opaque
// failure the first time they try to sign a transaction. Better to fail
// closed and point them at Petra explicitly.
//
// When Shelbynet gains Keyless support (or we move to a network that
// already has it), append "Continue with Google" / "Continue with Apple"
// here and broaden the ChromeBar/WalletButton readyState filter to
// include "Loadable" too.
const OPT_IN_WALLETS = ["Petra"] as const;

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AptosWalletAdapterProvider
      autoConnect
      optInWallets={OPT_IN_WALLETS}
      dappConfig={{ network: Network.SHELBYNET }}
      onError={(error) => {
        console.error("Wallet error:", error);
      }}
    >
      {/* SessionProvider lives BELOW the wallet adapter so it can         */}
      {/* useWallet() inside signIn / address-mismatch logic. Lifted from */}
      {/* useSession() so every consumer (pages + ChromeBar, which        */}
      {/* persists across routes inside ChromeShell) shares one state —  */}
      {/* fixes the dropdown that kept offering "Sign in" after the user */}
      {/* had already signed in elsewhere.                                 */}
      <SessionProvider>{children}</SessionProvider></AptosWalletAdapterProvider>
  );
}
