"use client";

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/useSession";

function truncateAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { connect, disconnect, account, connected, wallets } = useWallet();
  const { session, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (connected && account) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-200 hover:bg-zinc-700"
        >
          <span>{truncateAddress(account.address.toString())}</span>
          <span className="text-zinc-500">▾</span>
        </button>

        {open && (
          <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 p-1 shadow-xl">
            {session && (
              <button
                type="button"
                onClick={async () => {
                  setOpen(false);
                  await signOut();
                }}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
              >
                Sign out from app
                <span className="block text-[11px] text-zinc-500">
                  Clears your session, keeps the wallet connected.
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                // Drop the SIWA cookie too so we don't leave a stale session
                // tied to a wallet that's no longer connected here.
                if (session) await signOut();
                await disconnect();
              }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
            >
              Disconnect wallet
              <span className="block text-[11px] text-zinc-500">
                Forgets the wallet and signs out of the app.
              </span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // We allowlist only Petra in providers.tsx (no Backpack / OKX /
  // keyless social — Shelbynet doesn't ship the Aptos Keyless module),
  // so `wallets` already contains only Petra, and the dropdown UX is
  // simply: connect if Petra is installed, otherwise install link.
  //
  // Dedupe by name: Petra registers itself twice (legacy adapter-plugin
  // path + AIP-62 wallet standard event), and the Aptos adapter keeps
  // both. Without this filter the dropdown shows two identical
  // "Petra" buttons.
  const installedWallets = (wallets?.filter((w) => w.readyState === "Installed") ?? [])
    .filter((w, i, arr) => arr.findIndex((x) => x.name === w.name) === i);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200"
      >
        Connect Wallet
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-xl">
          {installedWallets.length > 0 ? (
            installedWallets.map((w) => (
              <button
                key={w.name}
                type="button"
                onClick={() => {
                  connect(w.name);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              >
                {w.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.icon} alt="" className="h-6 w-6 rounded" />
                )}
                <span>{w.name}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3">
              <p className="text-sm text-zinc-300">
                Frameloop signs in with Petra.
              </p>
              <a
                href="https://petra.app/"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-sm text-white underline decoration-zinc-500 underline-offset-4 hover:decoration-white"
              >
                Install Petra →
              </a>
              <p className="mt-2 text-[11px] text-zinc-500">
                Refresh this page after installing.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
