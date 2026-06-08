"use client";

/**
 * Vault — the signature interaction of Frameloop.
 *
 * A horizontal strip of polaroid-style photo cards. ALL cards are the same
 * size — there's no "active scale". Instead a V-shaped mask-image is layered
 * over the strip: fully opaque in the dead centre, tapering to transparent
 * at the viewport edges. As the user scrubs the timeline, photos slide
 * through that mask and "emerge" into focus by virtue of the cell directly
 * above the ruler-pin being the brightest point.
 *
 * Scroll is driven by:
 *   - Native horizontal scroll on the strip (trackpad pan, momentum).
 *   - A wheel listener that converts vertical wheel deltas to horizontal
 *     scroll (so a normal mouse user can scrub too).
 *   - Arrow buttons that call scrollIntoView({ inline: 'center' }) on the
 *     neighbouring card — works through scroll-snap without snap-fighting.
 *
 * The active card (the one nearest the centre pin) drives the date display.
 */

import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

export type VaultPost = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  caption: string | null;
  createdAt: string;
};

type VaultProps = {
  /** Any order — Vault sorts oldest→newest internally (left→right). */
  posts: VaultPost[];
  /**
   * Currently-selected postId, or null. Selection is owned by the parent
   * page so it can pivot its ChromeBar rightSlot (upload → trash) without
   * the Vault having to know about that surface.
   *
   * Selection model:
   *   • double-click a card  → onSelect(postId)
   *   • Esc or click on a different card → onSelect(null)
   */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /**
   * True while the parent is performing the on-chain delete. We dim the
   * selected card and lock further selection changes; everything else
   * stays interactive.
   */
  deleting?: boolean;
  /**
   * Optional node anchored to the selected card. Rendered just above
   * the photo, centred horizontally, position-fixed in screen
   * coordinates so it isn't clipped by the strip's overflow-y-hidden.
   * Tracks the card across scrolls and resizes.
   *
   * The parent provides this (typically a trash/confirm pill); Vault
   * only handles where to put it. Nothing renders if nothing's
   * selected.
   */
  selectionOverlay?: ReactNode;
};

// English month + weekday names, hardcoded so output is deterministic across
// servers and doesn't depend on the runtime's installed Intl data.
const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function formatDate(iso: string) {
  const d = new Date(iso);
  return {
    day: d.getDate(),
    month: MONTHS_EN[d.getMonth()],
    year: d.getFullYear(),
    weekday: WEEKDAYS_EN[d.getDay()],
  };
}

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

// Card geometry. Height is constant (the strip should read like a film
// reel — same baseline on every card), width varies per aspect bucket.
// The inner photo dimensions are CARD - PAD on each axis; we size cards
// so that the INNER photo matches the named aspect exactly, otherwise
// object-fit:cover would crop a little to compensate.
const CARD_H = 360;
const GAP = 32;
const PAD_X = 20; // .photo-card horizontal padding (10 + 10)
const PAD_Y = 24; // .photo-card vertical padding   (10 + 14)
const PHOTO_H = CARD_H - PAD_Y; // 336

/** Three IG-style aspect buckets — same vocabulary as Pool & cropper. */
type Aspect = "portrait" | "square" | "landscape";

const CARD_W_BY_ASPECT: Record<Aspect, number> = {
  portrait: Math.round(PHOTO_H * 0.8) + PAD_X, // 289
  square: PHOTO_H + PAD_X, // 356
  landscape: Math.round(PHOTO_H * 1.908) + PAD_X, // 661
};

/** Bucket a natural (w, h) into one of the three aspects. */
function classifyAspect(w: number, h: number): Aspect {
  if (w === 0 || h === 0) return "portrait";
  const r = w / h;
  if (r >= 1.15) return "landscape";
  if (r <= 0.95) return "portrait";
  return "square";
}

// V-shaped mask: transparent at the edges, fully opaque at the dead centre.
// The peak is narrow (50%) and the linear interpolation gives a smooth fall-off
// so neighbouring cards are still legible but distinctly secondary, and far
// cards drift into the paper.
const FADE_MASK =
  "linear-gradient(to right, transparent 0%, black 50%, transparent 100%)";

export function Vault({
  posts: rawPosts,
  selectedId = null,
  onSelect,
  deleting = false,
  selectionOverlay,
}: VaultProps) {
  // Sort oldest→newest so left = past, right = present.
  const posts = useMemo(
    () =>
      [...rawPosts].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [rawPosts],
  );

  const stripRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeIdx, setActiveIdx] = useState(posts.length - 1);

  // Aspect bucket per post. Defaults to "portrait" until the <img>
  // onLoad fires and tells us the natural dimensions — most uploads
  // are portrait so this is the smallest visible jump on classify.
  const [aspects, setAspects] = useState<Record<string, Aspect>>({});

  // Has the user touched the strip yet? Image-load classification can
  // change card widths, which shifts everyone's offsetLeft and would
  // de-centre the active card. We auto-recentre on widthchanges — but
  // ONLY while the user hasn't started scrubbing. Once they do, we
  // keep our hands off so we don't yank them mid-scroll.
  const userScrolledRef = useRef(false);

  // True when the timeline is precisely centred on a card (magnetic snap
  // has settled). Used to grow the centre pin so the user gets a clear
  // "you're on a photo" visual confirmation.
  const [isSnapped, setIsSnapped] = useState(true);
  const snappedRef = useRef(true);
  const setSnapped = useCallback((v: boolean) => {
    if (snappedRef.current === v) return; // dedupe — avoid rerenders per frame
    snappedRef.current = v;
    setIsSnapped(v);
  }, []);

  // Stable ref callbacks — one per index. React 19 RE-INVOKES inline ref
  // callbacks whose identity changed (cleanup with null, then attach), so
  // an inline `(el) => { cardRefs.current[i] = el }` would briefly null
  // out every card-ref on every parent re-render (and we re-render on
  // every scroll event because activeIdx is state). The tick loop reading
  // cardRefs in that gap would get nulls, bail out, and the magnetic snap
  // would never converge. Memoised callbacks keep identity stable across
  // renders, so refs stay attached.
  const cardRefSetters = useMemo(
    () =>
      Array.from(
        { length: posts.length },
        (_, i) => (el: HTMLDivElement | null) => {
          cardRefs.current[i] = el;
        },
      ),
    [posts.length],
  );

  // ──────────────────────────────────────────────────────────────────────
  //  Drum-physics scroll engine
  //
  //  We replace the browser's native momentum with our own velocity-based
  //  loop so:
  //    • multiple quick swipes accumulate into one fast spin,
  //    • the timeline keeps coasting after the finger leaves the trackpad,
  //    • mouse-wheel users get the same inertial feel (browser wheels are
  //      otherwise discrete and abrupt).
  //
  //  Each wheel event injects velocity (capped); a requestAnimationFrame
  //  loop applies it to scrollLeft per frame and decays it via friction.
  // ──────────────────────────────────────────────────────────────────────
  const velocityRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  // Timestamp of the last wheel event. The magnetic snap only engages once
  // this gets stale — otherwise the magnet fights the user's slow scrubs
  // and the whole thing feels like it's stuttering.
  const lastWheelAtRef = useRef(0);
  // Idle-timer that promotes the pin to "snapped" once scroll activity has
  // genuinely stopped. Lives outside the tick loop on purpose: the pin
  // state used to share state with the tick loop, which created a race
  // with macOS's post-finger-lift synthetic wheel events.
  const pinTimerRef = useRef<number | null>(null);

  const stopMomentum = useCallback(() => {
    velocityRef.current = 0;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;

    // Tuning constants.
    const FRICTION = 0.93; // momentum decay per frame
    const VELOCITY_CAP = 70;
    const COAST_FLOOR = 0.5; // |velocity| below this counts as "dead"
    const SNAP_DELAY_MS = 120; // magnet only engages this long after the
    // last wheel event — gives the user uninterrupted control of slow
    // scrubs and prevents the "fighting" feel that read as stutter.
    const SNAP_LERP = 0.16; // strength of the magnetic pull per frame
    const SNAP_DONE_PX = 1; // target ± this and we're done

    // Find the scrollLeft value that would centre the nearest card under the
    // pin. Rounded to integer so we never chase a fractional target the
    // browser is going to round away.
    function nearestCardScrollLeft(): number | null {
      const node = stripRef.current;
      if (!node) return null;
      const viewportCentre = node.scrollLeft + node.clientWidth / 2;
      let bestCard: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const card of cardRefs.current) {
        if (!card) continue;
        const cardCentre = card.offsetLeft + card.offsetWidth / 2;
        const dist = Math.abs(cardCentre - viewportCentre);
        if (dist < bestDist) {
          bestDist = dist;
          bestCard = card;
        }
      }
      if (!bestCard) return null;
      return Math.round(
        bestCard.offsetLeft - (node.clientWidth - bestCard.offsetWidth) / 2,
      );
    }

    // Frame loop. Three phases, in priority order:
    //   1. Coast — velocity has mass; apply it and decay via friction.
    //   2. Idle-hold — velocity is dead but user is still touching the
    //      wheel (last wheel < SNAP_DELAY_MS ago); just spin the loop
    //      without applying the magnet, otherwise it fights slow scrubs.
    //   3. Snap — user has been quiet long enough; lerp scrollLeft toward
    //      the nearest card centre until we're within SNAP_DONE_PX.
    //
    //  Important: this loop NEVER touches setSnapped. Pin state is owned
    //  entirely by the wheel handler (false) and the recomputeActive
    //  idle-timer (true). That's what removes the race with macOS
    //  momentum events.
    function tick() {
      const node = stripRef.current;
      if (!node) {
        animFrameRef.current = null;
        return;
      }

      // ── 1. Coast ──
      if (Math.abs(velocityRef.current) > COAST_FLOOR) {
        node.scrollLeft += velocityRef.current;
        const maxScroll = node.scrollWidth - node.clientWidth;
        if (node.scrollLeft <= 0 || node.scrollLeft >= maxScroll) {
          velocityRef.current = 0;
        } else {
          velocityRef.current *= FRICTION;
        }
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const userIdle = now - lastWheelAtRef.current >= SNAP_DELAY_MS;

      // ── 2. Idle-hold ──
      if (!userIdle) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }

      // ── 3. Snap ──
      const target = nearestCardScrollLeft();
      if (target === null) {
        animFrameRef.current = null;
        return;
      }
      const dist = target - node.scrollLeft;
      if (Math.abs(dist) < SNAP_DONE_PX) {
        node.scrollLeft = target;
        velocityRef.current = 0;
        animFrameRef.current = null;
        return;
      }
      // Lerp. Force at least 1px of movement so subpixel rounding can never
      // stall the loop (Retina + overflow:auto can refuse fractional
      // scrollLeft deltas and trap us in an "almost-there" oscillation).
      let step = dist * SNAP_LERP;
      if (Math.abs(step) < 1) step = Math.sign(dist);
      node.scrollLeft += step;
      animFrameRef.current = requestAnimationFrame(tick);
    }

    function onWheel(e: WheelEvent) {
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();

      // From here on we no longer auto-recentre on aspect classification
      // — the user is driving.
      userScrolledRef.current = true;
      lastWheelAtRef.current = performance.now();
      // Shrink the pin the instant the user touches the wheel. The macOS
      // race that used to cause problems lived in the tick loop — wheel
      // handler setting `false` is fine because the only thing that can
      // set it back to `true` is the idle-timer in recomputeActive, which
      // requires ALL scroll activity to stop first.
      setSnapped(false);

      // Sub-linear sensitivity curve: small movements barely tickle the
      // velocity, large ones lift it firmly. Each wheel-event injects:
      //
      //   v += sign(d) · |d|^0.85 · 0.22
      //
      //   d=2   → 0.39   (tiny twitch — gentle)
      //   d=10  → 1.6    (mouse-wheel notch — modest coast)
      //   d=50  → 6.3    (deliberate trackpad swipe)
      //   d=200 → 19.8   (vigorous flick — caps near the limit fast)
      //
      // This keeps the drum responsive on big spins while preventing tiny
      // accidental nudges from teleporting halfway through the timeline.
      const sign = delta < 0 ? -1 : 1;
      const accel = sign * Math.pow(Math.abs(delta), 0.85) * 0.22;
      velocityRef.current += accel;

      // Hard-cap so frantic stacking can't reach teleport speed.
      if (velocityRef.current > VELOCITY_CAP)
        velocityRef.current = VELOCITY_CAP;
      if (velocityRef.current < -VELOCITY_CAP)
        velocityRef.current = -VELOCITY_CAP;

      // Kick the loop if it isn't already running.
      if (animFrameRef.current === null) {
        animFrameRef.current = requestAnimationFrame(tick);
      }
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [setSnapped]);

  // Find the card whose centre is closest to the strip's viewport centre,
  // bleed the strip's scroll position into a CSS variable so the ruler
  // beneath can spin in lockstep, and reset an idle-timer that promotes the
  // pin to "snapped" once *all* scroll activity has actually ceased.
  //
  //  Why a timer instead of asking the tick loop: every scroll event —
  //  whether from wheel, smooth scrollIntoView, or the tick loop's own
  //  scrollLeft writes — reschedules this timer. It fires only after the
  //  strip has been completely still for SNAP_IDLE_MS. That gives us a
  //  single, race-free signal that "everything has stopped, including
  //  macOS's tail of momentum events".
  const recomputeActive = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;

    // Push scroll position to a CSS var on the Vault root. The ruler reads
    // this to offset its background-position, so its ticks slide with us.
    // This stays synchronous on every scroll event so the ruler doesn't
    // lag the photo strip even by a frame.
    const root = el.parentElement;
    if (root) {
      root.style.setProperty("--strip-x", `${-el.scrollLeft}px`);
    }

    const stripCentre = el.scrollLeft + el.clientWidth / 2;
    const halfViewport = el.clientWidth / 2;
    // Same single loop now does THREE jobs:
    //   1. Find the active (closest-to-centre) card → setActiveIdx.
    //   2. Write each card's opacity directly to its DOM node based on
    //      its CONTINUOUS distance from the viewport centre. Per-frame
    //      DOM writes are cheap and let us bypass React reconciliation
    //      — opacity now tracks scroll position smoothly instead of
    //      flipping discretely when activeIdx crosses a card boundary.
    //   3. Skip the opacity write when selection mode is active so the
    //      .photo-card--faded / .photo-card--selected classes own the
    //      opacity story (inline style wins over class — we'd fight
    //      them otherwise).
    //
    // The opacity curve is the same shape the old strip mask had:
    //   `opacity = max(0, 1 - distance / halfViewport)`
    // For a card whose centre is AT the viewport centre, opacity is 1
    // (and stays 1 across the card's full width regardless of how wide
    // the card is — that's the whole point of moving the fade from
    // pixel-space to card-space). At the viewport edge, opacity is 0.
    // Linear interpolation in between. We also apply a gentle eased
    // floor so cards that are technically past the edge but still
    // partly visible (during overscroll) don't pop to 0 instantly.
    const inSelectionMode = selectedId !== null;
    let closest = 0;
    let best = Infinity;
    for (let i = 0; i < cardRefs.current.length; i++) {
      const card = cardRefs.current[i];
      if (!card) continue;
      const cardCentre = card.offsetLeft + card.offsetWidth / 2;
      const dist = Math.abs(cardCentre - stripCentre);
      if (dist < best) {
        best = dist;
        closest = i;
      }

      if (inSelectionMode) {
        // Clear our inline opacity so the --faded / --selected CSS
        // classes can do their thing. We must do this on every
        // selection change so a card that was mid-fade when the user
        // double-clicked doesn't keep a stale numeric opacity.
        if (card.style.opacity !== "") card.style.opacity = "";
      } else {
        // Linear falloff matching the old mask's geometry.
        const t = halfViewport > 0 ? dist / halfViewport : 0;
        const o = t >= 1 ? 0 : 1 - t;
        // Round to 3 decimals — the eye can't tell apart 0.4827 from
        // 0.483 and avoiding the trailing precision means fewer style
        // recalcs when consecutive writes round to the same value.
        const rounded = Math.round(o * 1000) / 1000;
        const next = String(rounded);
        if (card.style.opacity !== next) card.style.opacity = next;
      }
    }
    setActiveIdx(closest);

    // Reschedule the pin-promotion check. As long as scroll events keep
    // firing (user wheels, macOS momentum, tick-loop scrollLeft writes),
    // this never resolves. Only the final lull triggers it.
    if (pinTimerRef.current !== null) {
      clearTimeout(pinTimerRef.current);
    }
    pinTimerRef.current = window.setTimeout(() => {
      pinTimerRef.current = null;
      const node = stripRef.current;
      if (!node) return;
      const centre = node.scrollLeft + node.clientWidth / 2;
      for (const card of cardRefs.current) {
        if (!card) continue;
        const cardCentre = card.offsetLeft + card.offsetWidth / 2;
        if (Math.abs(cardCentre - centre) < 3) {
          setSnapped(true);
          return;
        }
      }
    }, 220);
  }, [setSnapped, selectedId]);

  // Clean up the pin-promotion timer on unmount so we don't fire setState
  // against a torn-down component.
  useEffect(() => {
    return () => {
      if (pinTimerRef.current !== null) {
        clearTimeout(pinTimerRef.current);
        pinTimerRef.current = null;
      }
    };
  }, []);

  // Esc clears selection. Lives at window level so it works even when
  // focus is on the ChromeBar or anywhere else outside the strip. We only
  // bind the listener while there's something to clear, otherwise we'd
  // be a no-op on every Esc the user ever presses on this page.
  useEffect(() => {
    if (!selectedId || !onSelect) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onSelect?.(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onSelect]);

  // If the parent removes the selected post (e.g. delete just landed),
  // the selectedId pointer is now stale — clear it so the ChromeBar
  // falls back to the upload action.
  useEffect(() => {
    if (!selectedId || !onSelect) return;
    if (!posts.some((p) => p.postId === selectedId)) onSelect(null);
  }, [posts, selectedId, onSelect]);

  // ──────────────────────────────────────────────────────────────────────
  // Floating selection overlay (trash + confirm pill).
  //
  // The strip clips overflow-y, so we can't render the overlay as a child
  // of the selected card — it'd be cut off. Instead we measure the card's
  // viewport position and render the overlay as `position: fixed` above
  // it, tracking scroll/resize so it sticks to the photo if the user
  // scrubs the timeline mid-selection.
  // ──────────────────────────────────────────────────────────────────────
  const [overlayPos, setOverlayPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!selectedId || !selectionOverlay) {
      setOverlayPos(null);
      return;
    }
    const idx = posts.findIndex((p) => p.postId === selectedId);
    if (idx < 0) {
      setOverlayPos(null);
      return;
    }

    function update() {
      const card = cardRefs.current[idx];
      if (!card) return;
      const rect = card.getBoundingClientRect();
      // We sit the overlay just above the card's top edge, horizontally
      // centred. The selected-card lift (translateY(-4px)) is already
      // reflected in getBoundingClientRect, so the overlay naturally
      // follows it.
      setOverlayPos({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    }
    update();

    const strip = stripRef.current;
    strip?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      strip?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
    // Re-run when aspects change too — the card's width can morph after
    // image classification, shifting its centre.
  }, [selectedId, selectionOverlay, posts, aspects]);

  // Centre the *last* (newest) card on mount. We write scrollLeft
  // DIRECTLY inside the useLayoutEffect (instead of queuing the work
  // in a requestAnimationFrame, as the previous implementation did)
  // so the very first paint already shows the strip on the latest
  // card. The rAF version deferred scrollIntoView to the next frame,
  // which left a window where recomputeActive could run against
  // scrollLeft=0 — at that scroll the latest card sits well past the
  // viewport edge, so its computed opacity is 0 and the user sees a
  // blank timeline until the next scroll event refreshes the
  // opacities. Setting scrollLeft synchronously closes that window.
  //
  // Deps deliberately exclude `recomputeActive`. Its identity flips
  // every time `selectedId` changes (it closes over selection mode),
  // and re-running this effect on selection would yank the strip
  // back to the latest card every time the user double-clicks a
  // photo in the middle of the timeline. We only want to recentre
  // when the post list itself changes (initial mount, new upload).
  useLayoutEffect(() => {
    if (posts.length === 0) return;
    const lastIdx = posts.length - 1;
    setActiveIdx(lastIdx);
    const el = stripRef.current;
    const card = cardRefs.current[lastIdx];
    if (!el || !card) return;
    el.scrollLeft = Math.round(
      card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2,
    );
    recomputeActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length]);

  // When selection state toggles, fire recomputeActive once so the
  // inline opacity strategy (continuous distance fade vs. cleared-out
  // for the CSS classes to drive) matches the new mode without
  // waiting for the next scroll event.
  useEffect(() => {
    recomputeActive();
  }, [selectedId, recomputeActive]);

  // When card widths change because an image finished classifying, the
  // active card's offsetLeft shifts. Re-centre it instantly so the strip
  // doesn't appear to drift on its own. Only runs during the settling
  // phase (before the user touches the strip); once they scroll, this
  // effect short-circuits and stays out of their way.
  useLayoutEffect(() => {
    if (userScrolledRef.current) return;
    if (posts.length === 0) return;
    const card = cardRefs.current[activeIdx];
    if (!card) return;
    card.scrollIntoView({
      behavior: "instant",
      inline: "center",
      block: "nearest",
    });
    // scrollIntoView fires a scroll event WHEN scrollLeft actually
    // changes. If the post-classification layout happens to leave the
    // active card in the same scroll position (e.g. only widths to
    // the RIGHT of it changed), no scroll event, and the listener
    // doesn't refresh per-card opacity — every card would keep the
    // opacity calculated for the pre-classification geometry,
    // potentially leaving the visible cards at the wrong tint or
    // fading the active one to ~0. Call recomputeActive directly so
    // opacities track the new offsetLeft / offsetWidth even when
    // scrollLeft happens to coincide with the previous value.
    recomputeActive();
  }, [aspects, activeIdx, posts.length, recomputeActive]);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    el.addEventListener("scroll", recomputeActive, { passive: true });
    window.addEventListener("resize", recomputeActive);
    return () => {
      el.removeEventListener("scroll", recomputeActive);
      window.removeEventListener("resize", recomputeActive);
    };
  }, [recomputeActive]);

  const scrollToIdx = useCallback(
    (idx: number) => {
      // Kill any in-flight momentum so it can't drag the smooth-scroll past
      // the target.
      stopMomentum();
      const card = cardRefs.current[idx];
      if (!card) return;
      // Arrow / click navigation also counts as "user is driving" — once
      // they've nudged the strip we stop our settling-time auto-recentre.
      userScrolledRef.current = true;
      // Shrink the pin for the duration of the transit; the recomputeActive
      // idle-timer will grow it again once the smooth scroll has settled.
      setSnapped(false);
      card.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    },
    [stopMomentum, setSnapped],
  );

  const active = posts[activeIdx];
  const date = useMemo(
    () => (active ? formatDate(active.createdAt) : null),
    [active],
  );

  if (posts.length === 0) {
    // w-full so the column fills the page main (which uses items-center
    // on the cross-axis only). Without this, the empty-state text
    // collapses to its intrinsic width and sticks to the left edge.
    return (
      <div className="flex w-full min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <p
          style={{ fontFamily: "var(--font-display)" }}
          className="text-3xl tracking-tight text-[var(--color-ink)]"
        >
          A blank album.
        </p>
        <p className="mt-3 max-w-sm text-sm text-[var(--color-mute)]">
          Your vault is empty. Tap the plus at the top right to add your first
          memory.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-stretch">
      {/* PHOTO STRIP.
       *
       *  We used to apply a `mask-image: linear-gradient(transparent →
       *  black → transparent)` to this whole element. Visually that
       *  gave us the V-shaped fade, but it was a PIXEL-LEVEL mask in
       *  viewport coordinates. Narrow portrait cards stayed inside the
       *  opaque centre and looked fine — but wide landscape cards
       *  spilled into the fade tails, so their LEFT and RIGHT edges
       *  rendered at ~65% alpha while the middle was 100%. The active
       *  photo wasn't visible in its true colour edge-to-edge.
       *
       *  Fix: drop the strip mask entirely and instead fade WHOLE
       *  CARDS based on their distance from the centre. The active
       *  card is fully opaque from edge to edge regardless of its
       *  width; neighbours dim as units rather than melting inward.
       *  See `distanceOpacity` below. */}
      <div
        ref={stripRef}
        className="no-scrollbar paper-rise relative flex w-full min-w-0 overflow-x-auto overflow-y-hidden"
        style={{
          paddingTop: 56,
          paddingBottom: 56,
          paddingLeft: "50vw",
          paddingRight: "50vw",
          gap: `${GAP}px`,
          overscrollBehavior: "contain",
        }}
      >
        {posts.map((p, i) => {
          // Default to "portrait" until the image classifies — most of
          // our content is portrait so this is the smallest visible
          // jump for the common case. Width animates smoothly when the
          // bucket is corrected on load.
          const aspect = aspects[p.postId] ?? "portrait";
          const isSelected = selectedId === p.postId;
          // When the user has flagged one photo (double-click → selected),
          // the strip enters a "you are picking this one" mode: the
          // selected card lifts above the rest, everything else fades to
          // a quiet whisper so the eye is unambiguous about what the
          // trash icon will affect.
          const hasSelection = selectedId !== null;
          const isFaded = hasSelection && !isSelected;
          // No discrete inline `opacity` here on purpose. Position-
          // driven opacity is written DIRECTLY to each card.style by
          // recomputeActive on every scroll tick — that's what gives
          // the smooth continuous fade (cards dim as they drift away
          // from the centre, not in stepped flips when activeIdx
          // crosses a card boundary). Selection mode is the only path
          // where opacity goes through CSS classes (--faded /
          // --selected); during selection, recomputeActive clears the
          // inline opacity so those classes win.
          return (
            <div
              key={p.postId}
              ref={cardRefSetters[i]}
              className={`photo-card flex shrink-0 cursor-pointer${
                isSelected ? " photo-card--selected" : ""
              }${isFaded ? " photo-card--faded" : ""}${
                deleting && isSelected ? " photo-card--deleting" : ""
              }`}
              style={{
                width: CARD_W_BY_ASPECT[aspect],
                height: CARD_H,
                // No width transition on purpose. See the comment on
                // `.photo-card` in globals.css — the size morph used to
                // animate over 380ms, but that left the strip mis-centred
                // for the duration of the animation because the React
                // re-centre fires synchronously against OLD dimensions.
                // Instant snap → recentring math always matches reality.
              }}
              onClick={() => {
                // Single click: keep the legacy "scroll this into the
                // centre pin" behaviour. If something else is selected,
                // a click on a *different* card clears the selection —
                // matches Finder/Photos: clicking another item swaps
                // the active item, doesn't multi-select.
                if (selectedId && selectedId !== p.postId) {
                  onSelect?.(null);
                }
                scrollToIdx(i);
              }}
              onDoubleClick={(e) => {
                // Browsers fire a synthetic click(s) before dblclick;
                // we don't want the single-click branch above to clear
                // a selection we're about to create.
                e.stopPropagation();
                if (deleting) return;
                // Toggle: if you double-click the already-selected card,
                // the most natural interpretation is "cancel" — same as
                // Esc.
                onSelect?.(isSelected ? null : p.postId);
                scrollToIdx(i);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={blobUrl(p.ownerAddress, p.blobName)}
                alt={p.caption ?? ""}
                className="photo-card__img"
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const next = classifyAspect(
                    el.naturalWidth,
                    el.naturalHeight,
                  );
                  setAspects((prev) =>
                    prev[p.postId] === next
                      ? prev
                      : { ...prev, [p.postId]: next },
                  );
                }}
              />
            </div>
          );
        })}
      </div>

      {/* RULER — tick marks via repeating linear-gradient. Spans the full     */}
      {/* viewport, masked with the same V-shape fade as the photo strip so   */}
      {/* the ticks taper into the paper at both edges. The ruler reads       */}
      {/* --strip-x from the Vault root to slide its ticks in lockstep with   */}
      {/* the photos above — that's the "drum" you feel when scrubbing.       */}
      <div className="ruler-draw relative mt-6 w-full">
        <div
          className="ruler-h"
          style={{
            WebkitMaskImage: FADE_MASK,
            maskImage: FADE_MASK,
          }}
        />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
          {/* The pin grows to 2× its idle height the moment the timeline    */}
          {/* snaps to a photo — a small, satisfying confirmation that the   */}
          {/* drum has settled. The open chevron above the line fades in     */}
          {/* alongside the growth, pointing up at the chosen photo like a   */}
          {/* roof. Both shrink/hide the instant the user scrolls.            */}
          <div
            className="ruler-pin"
            style={{
              height: isSnapped ? 48 : 24,
              transition:
                "height 280ms var(--ease-paper), background-color 280ms var(--ease-paper)",
            }}
          >
            <svg
              aria-hidden
              width="10"
              height="6"
              viewBox="0 0 10 6"
              fill="none"
              className="ruler-pin__tip"
              style={{
                opacity: isSnapped ? 1 : 0,
                transform: `translateX(-50%) translateY(${isSnapped ? 0 : 3}px)`,
                transition:
                  "opacity 220ms var(--ease-paper), transform 220ms var(--ease-paper)",
              }}
            >
              <path
                d="M1 5L5 1L9 5"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* DATE STRIP — date centred, arrows pinned to opposite corners.
          Date row spans full viewport so the arrows can reach the edges. */}
      <div className="paper-rise relative flex w-full items-center justify-center px-8 pb-12 pt-8 sm:px-12">
        <button
          type="button"
          onClick={() => scrollToIdx(Math.max(0, activeIdx - 1))}
          disabled={activeIdx === 0}
          className="absolute left-8 text-[var(--color-ink)] transition disabled:opacity-25 sm:left-12"
          aria-label="Earlier memory"
        >
          <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
            <path
              d="M8 3L4 7L8 11M4 7H26"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </svg>
        </button>

        {/* Date crossfade: keyed by the date string so the transition only   */}
        {/* fires when the day actually changes — flipping between two cards  */}
        {/* taken on the same day leaves the date sitting still.              */}
        <div className="relative h-[3.25rem] min-w-[260px] text-center sm:h-[3.5rem]">
          <AnimatePresence mode="wait">
            {date && (
              <motion.div
                key={`${date.year}-${date.month}-${date.day}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="absolute inset-0 flex flex-col items-center justify-center"
              >
                <h1
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-2xl tracking-tight text-[var(--color-ink)] sm:text-3xl"
                >
                  {date.day} {date.month} {date.year}
                </h1>
                <p className="mt-1 text-xs text-[var(--color-mute)]">
                  {date.weekday}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={() =>
            scrollToIdx(Math.min(posts.length - 1, activeIdx + 1))
          }
          disabled={activeIdx === posts.length - 1}
          className="absolute right-8 text-[var(--color-ink)] transition disabled:opacity-25 sm:right-12"
          aria-label="Later memory"
        >
          <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
            <path
              d="M20 3L24 7L20 11M24 7H2"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </svg>
        </button>
      </div>

      {/* SELECTION OVERLAY — floats above the chosen card.
          Position-fixed so it isn't clipped by the strip's overflow-y;
          tracked across scrolls so it stays anchored to the photo.
          The 18px gap above the card matches the strip's paddingTop:56
          minus the overlay's ~38px height — visually the pill sits in
          the breathing room between the photo and the chrome bar. */}
      {selectionOverlay && overlayPos && (
        <div
          // pointer-events-none on the wrapper so the empty space around
          // the pill doesn't intercept clicks on the photo below it;
          // pointer-events-auto on the inner block re-enables them on
          // the actual buttons.
          className="pointer-events-none fixed z-40"
          style={{
            left: overlayPos.x,
            top: overlayPos.y - 18,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="pointer-events-auto animate-[paper-rise_240ms_var(--ease-paper)_both]">
            {selectionOverlay}
          </div>
        </div>
      )}
    </div>
  );
}
