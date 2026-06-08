"use client";

/**
 * App-wide chrome shell.
 *
 * Why this exists: when each route owned its own <ChromeBar/>, the chrome
 * would unmount and re-mount on every navigation. Even with identical
 * Tailwind classes and a `sticky top-0` header, sub-pixel layout
 * differences crept in between routes — a Suspense boundary that
 * temporarily emptied the column below the bar, a scrollbar that briefly
 * appeared mid-route-transition, a flex sibling whose width changed
 * after first paint. Each of those nudged the absolute-positioned nav
 * by a few pixels, and the user perceived it as the bar "jumping" when
 * moving between /, /search, and /upload.
 *
 * The fix is structural: render the bar exactly once, in the root
 * layout, so it never goes through React's mount/unmount cycle between
 * routes. The page below it changes; the chrome above it does not. Each
 * page contributes its own per-page action (upload "+", cancel "×",
 * etc.) via a React portal into a stable slot inside the bar.
 *
 *   <ChromeShell>           ← lives in src/app/layout.tsx
 *     ├ <ChromeBar />       ← rendered once, never unmounts on nav
 *     └ {children}          ← whichever route is active
 *
 *   <ChromeRightSlot>       ← used by each paper page in its tree
 *     <UploadPlus />
 *   </ChromeRightSlot>
 *
 * Old dark-design routes (/me, /u/[address], /pool/[tag], /login)
 * keep their own SiteHeader — ChromeShell detects those pathnames and
 * just renders {children} without wrapping anything. So the redesign
 * can roll out per-route without breaking the holdouts.
 */

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { ChromeBar } from "./ChromeBar";

const ChromeRightSlotElContext = createContext<HTMLElement | null>(null);

// Paper-design routes. The list is small and explicit on purpose —
// adding a new paper page is a one-line change here, and the old
// dark-themed holdouts (/me, /u/[address], /pool/[tag], /login) stay
// out so they keep rendering their own SiteHeader unaffected.
function isPaperRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname === "/feed" || pathname.startsWith("/feed/")) return true;
  if (pathname === "/pool") return true;
  if (pathname === "/pool/tags") return true;
  // /pool/[tag] keeps its old dark layout — intentionally excluded.
  if (pathname === "/search" || pathname.startsWith("/search/")) return true;
  if (pathname === "/upload") return true;
  return false;
}

export function ChromeShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [rightSlotEl, setRightSlotEl] = useState<HTMLElement | null>(null);

  // Ref callback for ChromeBar's inner right-slot container. Stable so
  // ChromeBar doesn't see a new ref identity on every render — that
  // would cause it to call us with null then the new element again
  // every cycle.
  const onRightSlotRef = useCallback((el: HTMLDivElement | null) => {
    setRightSlotEl(el);
  }, []);

  if (!isPaperRoute(pathname)) {
    // Old-design route — let the page render its own header.
    return <>{children}</>;
  }

  return (
    <ChromeRightSlotElContext.Provider value={rightSlotEl}>
      {/* The flex-col wrapper used to be duplicated on every paper page. */}
      {/* It lives here now so every route shares the exact same shell.   */}
      <div className="flex h-screen flex-col">
        <ChromeBar rightSlotRef={onRightSlotRef} />
        {children}
      </div>
    </ChromeRightSlotElContext.Provider>
  );
}

/**
 * Portal target for per-page chrome actions.
 *
 * Drop this anywhere in a paper-page's JSX:
 *
 *   <ChromeRightSlot>
 *     <UploadPlus />
 *   </ChromeRightSlot>
 *
 * The children render INSIDE the chrome bar's right slot, but they
 * live in the page's React tree — so they can read page state, useEffect,
 * useWallet, etc. without any prop-drilling through the layout.
 *
 * If the route isn't a paper route (no chrome rendered), this just
 * renders nothing. Safe to use unconditionally.
 */
export function ChromeRightSlot({ children }: { children: ReactNode }) {
  const el = useContext(ChromeRightSlotElContext);
  if (!el) return null;
  return createPortal(children, el);
}
