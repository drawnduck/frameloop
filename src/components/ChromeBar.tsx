"use client";

/**
 * Unified top chrome for every primary page in the paper-white design.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  ◯       Remember  Look at friends  ...  Upload   ⊟  Frameloop │
 *   └────────────────────────────────────────────────────────────────┘
 *
 *   Top-left:  a 36px circle. Avatar when signed in, "M" wordmark
 *              otherwise. Clicking it opens a SMALL dropdown that ONLY
 *              handles wallet state (connect / sign-in / disconnect —
 *              disconnect rolls signOut + wallet.disconnect into one
 *              tap; the old standalone "Sign out" was removed because
 *              nobody wants the dangling-session intermediate state).
 *              Site navigation is no longer hidden behind this menu.
 *
 *              The dropdown PANEL is rendered via createPortal into
 *              <body>, not as a child of the trigger. This is the fix
 *              for "menu won't click on / and /feed": when the panel
 *              lived in the page tree, hit-testing on those routes
 *              surfaced the Vault/FeedTimeline strip (with its mask-
 *              image + transform stacking contexts) as the topmost
 *              element under the cursor, and the document-level
 *              mousedown handler closed the menu on the first click
 *              inside it. At <body> level the panel can't be covered.
 *
 *   Centre:    a row of section labels in the display face — Vault /
 *              Feed / Pool / Search / Upload. Hovering a label lifts its
 *              colour to ink and scales it up by ~8%. The active section
 *              wears a small ink dot underneath.
 *
 *   Top-right: an inline cluster of [per-page action] [wordmark]. The
 *              action is a 36px contextual button each page can
 *              portal in via <ChromeRightSlot> (Vault uses `+` for
 *              upload, etc.). The "Frameloop" wordmark anchors the
 *              corner on every paper route so the brand reads
 *              regardless of which page you're on. Wordmark is
 *              hidden below the sm breakpoint to give the nav room
 *              on narrow viewports.
 *
 *  Why this is a structural rewrite, not a tweak: the previous version
 *  hid the whole nav inside the dropdown, and that dropdown's parent
 *  laid an absolute, full-width `centre` slot across the header — with
 *  `z-[-1]` on the wrapper and `pointer-events-auto` on the inner span
 *  it intercepted clicks on Vault/Feed once the timeline below changed
 *  the stacking context. Pulling nav into the chrome row removes both
 *  problems: no full-width overlay, and no menu the user can't click.
 */

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AvatarImage } from "@/components/AvatarImage";
import { ProfileEditModal } from "@/components/ProfileEditModal";
import { useSession } from "@/lib/useSession";

type ChromeBarProps = {
  /**
   * Ref callback that receives the inner right-slot container. Used by
   * ChromeShell to expose the slot as a React portal target so pages
   * can drop their own per-page action (upload "+", cancel "×", filter,
   * etc.) into the chrome without unmounting the chrome itself between
   * routes. See ChromeShell for the wider context.
   */
  rightSlotRef?: (el: HTMLDivElement | null) => void;
};

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

type NavItem = {
  href: string;
  label: string;
  /** Is this nav item the one that owns the current path? */
  match: (path: string) => boolean;
};

// Labels are verbal — invitations to the user, not noun categories.
// Vault / Feed / Pool felt like product chrome; "Remember" /
// "Look at friends" / "Look at everyone" read like a gentle prompt
// matching the journal voice of the rest of the app. URLs are
// unchanged so existing deep-links keep working.
const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Remember", match: (p) => p === "/" },
  {
    href: "/feed",
    label: "Look at friends",
    match: (p) => p === "/feed" || p.startsWith("/feed/"),
  },
  {
    href: "/pool",
    label: "Look at everyone",
    match: (p) => p === "/pool" || p.startsWith("/pool/"),
  },
  {
    href: "/search",
    label: "Search",
    match: (p) => p === "/search" || p.startsWith("/search/"),
  },
  { href: "/upload", label: "Upload", match: (p) => p === "/upload" },
] as const;

export function ChromeBar({ rightSlotRef }: ChromeBarProps) {
  const { account, connected, wallets, connect, disconnect } = useWallet();
  const { session, signIn, signOut, status } = useSession();
  const path = usePathname() ?? "/";

  const [open, setOpen] = useState(false);
  const [avatarBlob, setAvatarBlob] = useState<string | null>(null);
  // Profile-edit modal: opened from the "Edit profile" item in the
  // wallet dropdown, lives at <body> level via createPortal (see
  // ProfileEditModal.tsx).
  const [editOpen, setEditOpen] = useState(false);
  // Bumped after a successful save inside the modal so the avatar
  // refetch effect re-runs and the chrome dot updates without a page
  // reload.
  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0);
  // Two refs, two jobs:
  //   triggerRef → the 36×36 wallet button. We measure its
  //                 getBoundingClientRect() on open to anchor the dropdown.
  //   dropdownRef → the floating panel, rendered via portal to <body>.
  //                  Needed so the outside-click handler can recognise
  //                  clicks on the panel as "inside" the menu — without
  //                  it, the portal'd DOM lives outside any wrapper we
  //                  control and document.contains(target) would falsely
  //                  report every click on a menu item as "outside",
  //                  closing the menu before its onClick can run.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{
    left: number;
    top: number;
  } | null>(null);

  // Anchor the dropdown to the trigger. Recompute on open, resize, and
  // (defensively) scroll — the chrome is `sticky top-0` so it shouldn't
  // move with the page, but recalculating costs nothing and protects
  // against future layout changes.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      setDropdownPos({
        // Anchor to the trigger's left edge so the panel hangs straight
        // down from the M wordmark, matching the previous absolute
        // `left-0 top-12` layout visually.
        left: Math.round(r.left),
        // 6px gap below the trigger — same visual rhythm as before but
        // computed from the button's real bottom edge instead of a
        // hardcoded `top-12`, so it doesn't drift if chrome padding
        // changes between breakpoints.
        top: Math.round(r.bottom + 6),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, [open]);

  // Outside-click closer. Because the dropdown is portaled to <body>,
  // it isn't a DOM descendant of the trigger any more — we have to ask
  // both refs whether the click came from inside.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Pull avatar blob name once we have a session. Also re-runs when
  // `avatarRefreshKey` increments — that's the signal from
  // ProfileEditModal that the user just saved a new avatar and the
  // chrome dot needs to reflect it.
  useEffect(() => {
    if (!session) {
      setAvatarBlob(null);
      return;
    }
    let aborted = false;
    fetch(`/api/profiles/${session.address}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { profile?: { avatarBlobName?: string | null } } | null) => {
        if (aborted) return;
        setAvatarBlob(j?.profile?.avatarBlobName ?? null);
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, [session, avatarRefreshKey]);

  const address = account?.address.toString().toLowerCase() ?? null;
  const isSignedIn = !!session;
  // Dedupe by name. Petra (and similarly architected wallets) registers
  // itself twice — once via the legacy `window.aptos` adapter-plugin path
  // and again via the AIP-62 wallet standard event. The Aptos adapter
  // happily keeps both entries in `wallets`, so without this filter the
  // dropdown would render two "Connect Petra" buttons (and React would
  // warn about duplicate keys). First occurrence wins; the underlying
  // extension is the same either way, so the user-visible behaviour is
  // identical.
  const installed = (wallets?.filter((w) => w.readyState === "Installed") ?? [])
    .filter((w, i, arr) => arr.findIndex((x) => x.name === w.name) === i);

  return (
    // 3-column grid: [minmax(0,1fr)] [auto] [minmax(0,1fr)].
    //
    // Why this exact shape, post-rebrand:
    //
    //   - The middle column is `auto` so it sizes to the nav's natural
    //     width. Nothing pushes the nav around.
    //   - The two side columns are `minmax(0, 1fr)` — they share the
    //     remaining space EQUALLY, regardless of what's inside them.
    //     The wallet button (36px) on the left and the action +
    //     wordmark cluster (≈140px on sm+) on the right would
    //     otherwise create asymmetric columns and shift the nav.
    //     minmax(0, 1fr) forbids the columns from growing past their
    //     equal share — content overflows visually if it ever doesn't
    //     fit, but the columns themselves stay mathematically equal.
    //   - With the columns equal, justify-self-start on the wallet
    //     button and justify-self-end on the right cluster pin them
    //     to the outer edges (mirroring each other across the
    //     viewport centre), and the nav in between is geometrically
    //     centred for free.
    //
    // sticky top-0 + paper background pins the header to the viewport
    // even when something below it scrolls (shouldn't happen with our
    // h-screen wrappers, but kept as a safety net).
    <header className="sticky top-0 z-30 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 bg-[var(--color-paper)] px-6 py-4 sm:px-10 sm:py-5">
      {/* LEFT — wallet menu trigger. The dropdown PANEL itself is no
          longer rendered here as an absolute child; it's portaled to
          <body> at the bottom of this component so it can never be
          clipped or click-blocked by anything inside the page tree
          (Vault's mask-image strip, FeedTimeline's absolute topRegion,
          etc.). All that lives here now is the 36px M button. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chrome-dot justify-self-start overflow-hidden"
        aria-label="Wallet"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <AvatarImage
          src={
            isSignedIn && avatarBlob && address
              ? blobUrl(address, avatarBlob)
              : null
          }
          className="h-full w-full object-cover"
          fallback={
            // Wallet glyph — shown whenever there's no avatar to
            // display. A wallet icon makes the button's purpose
            // obvious: tap to manage the connected wallet, sign in,
            // or install Petra.
            //
            // Hairline stroke at 1px to match the rest of the paper
            // chrome (arrows, +, trash). The clasp dot is filled so
            // the icon reads at the 36px chrome-dot size — a single
            // outline would lose weight against the surface.
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <rect
                x="1.75"
                y="4.5"
                width="12.5"
                height="8"
                rx="1.25"
                stroke="currentColor"
                strokeWidth="1"
              />
              <path
                d="M3 4.5V3.25a1 1 0 0 1 1-1h7"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
              <circle cx="11.25" cy="8.5" r="0.7" fill="currentColor" />
            </svg>
          }
        />
      </button>

      {/* CENTRE — primary nav. Lives in the middle grid column. The
          column itself is geometrically centred between two equal-
          width side columns, so a simple justify-center on this flex
          row puts the nav at viewport centre — no absolute math, no
          mx-auto dance, nothing that can drift between routes. */}
      <nav aria-label="Primary" className="flex justify-center">
        <ul className="flex w-fit items-center gap-6 sm:gap-9">
          {NAV_ITEMS.map((item) => {
            const active = item.match(path);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`chrome-nav-link${active ? " is-active" : ""}`}
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* RIGHT — per-page action slot + brand wordmark, hugging the
          right edge of their grid column. The slot lives on the LEFT
          of the wordmark so the wordmark stays in the actual corner
          across every paper route (with or without a per-page
          action). The wordmark is hidden below the sm breakpoint so
          mobile viewports give the nav as much room as possible. */}
      <div className="flex items-center gap-4 justify-self-end sm:gap-5">
        <div
          ref={rightSlotRef}
          className="relative z-20 flex items-center justify-center"
        />
        <span
          aria-label="Frameloop"
          style={{ fontFamily: "var(--font-display)" }}
          className="hidden text-lg italic tracking-tight text-[var(--color-ink)] sm:inline-block"
        >
          Frameloop
        </span>
      </div>

      {/* ──────────────────────────────────────────────────────────────
          WALLET DROPDOWN — portaled to <body>.

          Rendering this here, as part of the page tree, used to fail on
          /  and /feed: the strip below the chrome bar (Vault: mask-image
          + paper-rise transform; FeedTimeline: absolute inset-0 with a
          wheel listener) intercepted clicks before they could reach the
          dropdown items. Even with z-40 on the dropdown and z-30 on the
          header, hit-testing surfaced the strip as the click target —
          which the outside-click handler interpreted as "user clicked
          outside the menu" and closed it on mousedown, before the menu
          item's onClick could fire.

          Portaling to <body> sidesteps the entire class of bugs: the
          dropdown lives at the DOM root, so it isn't inside any of the
          page's stacking contexts and can't be covered by them. The
          coordinates come from triggerRef.getBoundingClientRect(), so
          the panel still appears immediately under the M button.
          ────────────────────────────────────────────────────────────── */}
      {open && dropdownPos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={dropdownRef}
              style={{
                position: "fixed",
                left: dropdownPos.left,
                top: dropdownPos.top,
                zIndex: 1000,
              }}
              className="w-60 origin-top-left animate-[paper-rise_280ms_var(--ease-paper)_both] overflow-hidden rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(0,0,0,.04),0_24px_48px_-12px_rgba(0,0,0,.14)]"
              role="menu"
            >
              <div className="py-2">
                {isSignedIn && address ? (
                  <>
                    {/* Static account label — no longer a link. Used
                        to point at /u/{address}, but that route still
                        carries the old dark layout and clicking from
                        the paper chrome into a black page was jarring.
                        We'll restore the link once /u/[address] is
                        ported to the paper aesthetic. */}
                    <div
                      className="block px-4 py-2 text-[11px] text-[var(--color-mute)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                      aria-label="Connected account"
                    >
                      {truncate(address)}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setEditOpen(true);
                      }}
                      className="block w-full px-4 py-2 text-left text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)]"
                      role="menuitem"
                    >
                      Edit profile
                    </button>
                    {/* Disconnect = signOut + disconnect in one tap.
                        We removed the standalone "Sign out" entry —
                        users with a connected wallet always want both
                        side-effects together, so a separate Sign out
                        was just a step they had to click through. */}
                    <button
                      type="button"
                      onClick={async () => {
                        setOpen(false);
                        await signOut();
                        await disconnect();
                      }}
                      className="block w-full px-4 py-2 text-left text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)]"
                      role="menuitem"
                    >
                      Disconnect wallet
                    </button>
                  </>
                ) : connected ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      signIn();
                    }}
                    className="block w-full px-4 py-2 text-left text-sm text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
                    role="menuitem"
                  >
                    {status === "signing" ? "Signing…" : "Sign in"}
                  </button>
                ) : installed.length > 0 ? (
                  installed.map((w) => (
                    <button
                      key={w.name}
                      type="button"
                      onClick={() => {
                        connect(w.name);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
                      role="menuitem"
                    >
                      {w.icon && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={w.icon} alt="" className="h-4 w-4 rounded" />
                      )}
                      <span>Connect {w.name}</span>
                    </button>
                  ))
                ) : (
                  // Petra-only onboarding. We opt-in only Petra in
                  // providers.tsx (the keyless social options would need
                  // the Aptos Keyless module on-chain, which Shelbynet
                  // does not have today), so an empty `installed` array
                  // simply means the user hasn't installed Petra yet.
                  // Give them a direct install link rather than a
                  // dead-end message.
                  <div className="px-4 py-3">
                    <p className="text-xs text-[var(--color-mute)]">
                      Frameloop signs in with the Petra wallet.
                    </p>
                    <a
                      href="https://petra.app/"
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-sm text-[var(--color-ink)] underline decoration-[var(--color-mute)] underline-offset-4 hover:decoration-[var(--color-ink)]"
                    >
                      Install Petra →
                    </a>
                    <p className="mt-2 text-[11px] text-[var(--color-mute)]">
                      Refresh this page after installing.
                    </p>
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* PROFILE EDIT MODAL — opens from the wallet dropdown's "Edit
          profile" item. Self-portals to <body>, so placing the JSX
          inside <header> here is purely about co-locating state with
          the dropdown that opens it. onSaved bumps avatarRefreshKey,
          which re-triggers the avatar-blob refetch above, so the
          chrome dot updates the moment a new avatar lands. */}
      <ProfileEditModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={() => setAvatarRefreshKey((k) => k + 1)}
      />
    </header>
  );
}
