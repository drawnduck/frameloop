"use client";

/**
 * FeedTimeline — Vault's vertical sibling.
 *
 * A single column of memory cards from the accounts you follow. The card
 * sitting at the viewport centre is "in focus"; cards above and below
 * fade through a V-shaped mask. A vertical ruler hugs the photo column's
 * left edge, its tick-marks sliding in lockstep with the photos — the
 * same drum effect Vault uses, rotated 90°. The per-post metadata
 * (date, weekday, owner avatar + name) lives in a third column to the
 * left of the ruler, sliding in horizontally on each change.
 *
 * Scroll is driven by a custom physics engine ported from Vault. The
 * wheel listener is attached to the *outer* top region, not the strip
 * itself, so wheel events anywhere over the layout — including the
 * empty area around the ruler and the side-text — drive the column.
 */

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { AvatarImage } from "@/components/AvatarImage";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type FeedPost = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  caption: string | null;
  tag: string | null;
  createdAt: string;
};

export type FeedOwner = {
  address: string;
  displayName: string | null;
  ansName: string | null;
  avatarBlobName: string | null;
};

type Props = {
  posts: FeedPost[];
  owners: Record<string, FeedOwner>;
  hasMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  loadingMore: boolean;
};

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

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

// Card width is fixed; height comes from each photo's own aspect ratio.
// We used to hard-code a 320×400 (4:5) box for every card, which made
// landscape and square shots look like awkward portraits with letter-
// boxing baked in via object-fit: cover. Now we classify each photo
// into one of three IG-style buckets on load and drive the card's
// height via CSS `aspect-ratio` — same vocabulary as Vault, PoolStack,
// and the cropper, so the visual language is consistent across the
// app.
const CARD_W = 320;
const GAP = 36;

/** Three IG-style aspect buckets — same vocabulary as Vault. */
type Aspect = "portrait" | "square" | "landscape";

const ASPECT_RATIO_CSS: Record<Aspect, string> = {
  portrait: "4 / 5",
  square: "1 / 1",
  landscape: "1.91 / 1",
};

/** Bucket a natural (w, h) into one of the three aspects. */
function classifyAspect(w: number, h: number): Aspect {
  if (w === 0 || h === 0) return "portrait";
  const r = w / h;
  if (r >= 1.15) return "landscape";
  if (r <= 0.95) return "portrait";
  return "square";
}

// Layout offsets (px), measured from the photo-column centre (which is the
// page's horizontal centre). Photo column is 320px wide so its left edge
// sits at calc(50% - 160px). The ruler hugs it from the left.
const PHOTO_HALF = CARD_W / 2; // 160
const RULER_GAP = 24; // gap between ruler's right edge and the photo
const RULER_W = 28; // matches .ruler-v width
const RULER_LEFT = PHOTO_HALF + RULER_GAP + RULER_W; // 212 → ruler.left = 50% - 212
const RULER_CENTRE = PHOTO_HALF + RULER_GAP + RULER_W / 2; // 198 → pin anchor
const SIDE_TEXT_LEFT = 400; // side-text.left = 50% - 400

// V-shaped mask on the Y axis: transparent at top/bottom, fully opaque
// at the centre. Same idea as Vault's horizontal version — only the card
// sitting in the opaque peak reads as the active one.
const FADE_MASK =
  "linear-gradient(to bottom, transparent 0%, black 50%, transparent 100%)";

export function FeedTimeline({
  posts,
  owners,
  hasMore,
  sentinelRef,
  loadingMore,
}: Props) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // The wheel listener lives on the TOP REGION (not the strip), so it
  // catches wheel events anywhere over the layout — including the
  // ruler, pin, and side-text overlays — and drives stripRef.scrollTop
  // programmatically. If we attached to stripRef directly, wheeling over
  // an overlay sibling of the strip would never reach the handler.
  const topRegionRef = useRef<HTMLDivElement | null>(null);
  // <article> elements give HTMLElement, not HTMLDivElement — be permissive.
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Aspect bucket per post. Defaults to "portrait" until the <img>
  // onLoad fires and tells us the natural dimensions. Portrait is the
  // best default because most uploads are portrait and "wrong by a
  // few px of height" is the smallest visible jump on classify-in.
  const [aspects, setAspects] = useState<Record<string, Aspect>>({});

  // Has the user touched the strip yet? Image-load classification can
  // change a card's height, which shifts every card below it and would
  // de-centre the active card. We re-centre on aspect changes — but
  // ONLY while the user hasn't started scrubbing. Once they do, we
  // keep our hands off so we don't yank them mid-scroll.
  const userScrolledRef = useRef(false);

  // Snap state for the chevron pin — identical pattern to Vault.
  const [isSnapped, setIsSnapped] = useState(true);
  const snappedRef = useRef(true);
  const setSnapped = useCallback((v: boolean) => {
    if (snappedRef.current === v) return; // dedupe — avoid rerenders per frame
    snappedRef.current = v;
    setIsSnapped(v);
  }, []);

  // Stable per-index ref callbacks so React 19 doesn't churn refs on every
  // re-render (every scroll event re-renders because activeIdx is state).
  const cardRefSetters = useMemo(
    () =>
      Array.from(
        { length: posts.length },
        (_, i) => (el: HTMLElement | null) => {
          cardRefs.current[i] = el;
        },
      ),
    [posts.length],
  );

  // ──────────────────────────────────────────────────────────────────────
  //  Drum-physics scroll engine — vertical port of Vault's.
  //
  //  The wheel listener is attached to the TOP REGION (a parent that
  //  covers the strip + every overlay). The handler injects velocity
  //  and starts the rAF loop, which manipulates stripRef.scrollTop. Once
  //  velocity is dead AND the user has been idle for SNAP_DELAY_MS, a
  //  magnetic lerp pulls the strip onto the nearest card centre. Pin
  //  state is owned only by onWheel (false) and recomputeActive's
  //  idle-timer (true); the tick loop never touches it.
  // ──────────────────────────────────────────────────────────────────────
  const velocityRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const lastWheelAtRef = useRef(0);
  const pinTimerRef = useRef<number | null>(null);

  const stopMomentum = useCallback(() => {
    velocityRef.current = 0;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    const top = topRegionRef.current;
    if (!top) return;

    const FRICTION = 0.93;
    const VELOCITY_CAP = 70;
    const COAST_FLOOR = 0.5;
    const SNAP_DELAY_MS = 120;
    const SNAP_LERP = 0.16;
    const SNAP_DONE_PX = 1;

    function nearestCardScrollTop(): number | null {
      const node = stripRef.current;
      if (!node) return null;
      const viewportCentre = node.scrollTop + node.clientHeight / 2;
      let bestCard: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const card of cardRefs.current) {
        if (!card) continue;
        const cardCentre = card.offsetTop + card.offsetHeight / 2;
        const dist = Math.abs(cardCentre - viewportCentre);
        if (dist < bestDist) {
          bestDist = dist;
          bestCard = card;
        }
      }
      if (!bestCard) return null;
      return Math.round(
        bestCard.offsetTop - (node.clientHeight - bestCard.offsetHeight) / 2,
      );
    }

    function tick() {
      const node = stripRef.current;
      if (!node) {
        animFrameRef.current = null;
        return;
      }

      // ── 1. Coast ──
      if (Math.abs(velocityRef.current) > COAST_FLOOR) {
        node.scrollTop += velocityRef.current;
        const maxScroll = node.scrollHeight - node.clientHeight;
        if (node.scrollTop <= 0 || node.scrollTop >= maxScroll) {
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
      const target = nearestCardScrollTop();
      if (target === null) {
        animFrameRef.current = null;
        return;
      }
      const dist = target - node.scrollTop;
      if (Math.abs(dist) < SNAP_DONE_PX) {
        node.scrollTop = target;
        velocityRef.current = 0;
        animFrameRef.current = null;
        return;
      }
      let step = dist * SNAP_LERP;
      if (Math.abs(step) < 1) step = Math.sign(dist);
      node.scrollTop += step;
      animFrameRef.current = requestAnimationFrame(tick);
    }

    function onWheel(e: WheelEvent) {
      // Feed scrolls vertically: deltaY is the relevant signal.
      const delta = e.deltaY;
      if (delta === 0) return;
      e.preventDefault();

      // From here on we no longer auto-recentre on aspect classification
      // — the user is driving.
      userScrolledRef.current = true;
      lastWheelAtRef.current = performance.now();
      setSnapped(false);

      const sign = delta < 0 ? -1 : 1;
      const accel = sign * Math.pow(Math.abs(delta), 0.85) * 0.22;
      velocityRef.current += accel;
      if (velocityRef.current > VELOCITY_CAP) velocityRef.current = VELOCITY_CAP;
      if (velocityRef.current < -VELOCITY_CAP)
        velocityRef.current = -VELOCITY_CAP;

      if (animFrameRef.current === null) {
        animFrameRef.current = requestAnimationFrame(tick);
      }
    }

    top.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      top.removeEventListener("wheel", onWheel);
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [setSnapped]);

  // recomputeActive runs on scroll: publishes scrollTop into --strip-y on
  // the top region (so the ruler-v inherits it and slides its ticks),
  // picks the new active card, writes per-card opacity based on each
  // card's continuous distance from the viewport centre, and
  // reschedules the idle-timer that promotes the pin to "snapped" once
  // everything stops.
  //
  // The per-card opacity write is what gives the smooth vertical fade
  // — same idea as Vault's horizontal version. Previously this strip
  // had a `mask-image: linear-gradient(transparent → black →
  // transparent)` mask on the Y axis, which faded pixels in viewport
  // coordinates. A 320×400 portrait card on a ~900px viewport hit the
  // mask tails at its top and bottom edges, so the photo rendered at
  // ~55% alpha there even when "centred". Moving the fade to per-card
  // opacity, computed from the card's CENTRE vs the viewport centre,
  // keeps the active photo at 100% across its full height regardless
  // of aspect bucket. The opacity formula matches the old mask's
  // geometry: `opacity = max(0, 1 - distance / halfViewport)`.
  const recomputeActive = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const top = topRegionRef.current;
    if (top) {
      top.style.setProperty("--strip-y", `${-el.scrollTop}px`);
    }

    const stripCentre = el.scrollTop + el.clientHeight / 2;
    const halfViewport = el.clientHeight / 2;
    let closest = 0;
    let best = Infinity;
    for (let i = 0; i < cardRefs.current.length; i++) {
      const card = cardRefs.current[i];
      if (!card) continue;
      const cardCentre = card.offsetTop + card.offsetHeight / 2;
      const dist = Math.abs(cardCentre - stripCentre);
      if (dist < best) {
        best = dist;
        closest = i;
      }

      // Linear falloff: 1 at centre, 0 at the viewport edge. Round to
      // 3 decimals so repeat scroll ticks that resolve to the same
      // visible value short-circuit the style write.
      const t = halfViewport > 0 ? dist / halfViewport : 0;
      const o = t >= 1 ? 0 : 1 - t;
      const next = String(Math.round(o * 1000) / 1000);
      if (card.style.opacity !== next) card.style.opacity = next;
    }
    setActiveIdx(closest);

    if (pinTimerRef.current !== null) clearTimeout(pinTimerRef.current);
    pinTimerRef.current = window.setTimeout(() => {
      pinTimerRef.current = null;
      const node = stripRef.current;
      if (!node) return;
      const centre = node.scrollTop + node.clientHeight / 2;
      for (const card of cardRefs.current) {
        if (!card) continue;
        const cardCentre = card.offsetTop + card.offsetHeight / 2;
        if (Math.abs(cardCentre - centre) < 3) {
          setSnapped(true);
          return;
        }
      }
    }, 220);
  }, [setSnapped]);

  useEffect(() => {
    return () => {
      if (pinTimerRef.current !== null) {
        clearTimeout(pinTimerRef.current);
        pinTimerRef.current = null;
      }
    };
  }, []);

  // Centre the first card (newest post) on mount. Same fix as Vault:
  // write scrollTop DIRECTLY inside the useLayoutEffect (no rAF) so
  // the very first paint shows the photo already centred vertically.
  // The rAF version deferred scrollIntoView to the next frame, which
  // meant the user briefly saw the strip at scrollTop=0 — the first
  // card sitting at the *top* of the viewport rather than its middle.
  // Setting scrollTop synchronously closes that window.
  useLayoutEffect(() => {
    if (posts.length === 0) return;
    setActiveIdx(0);
    const el = stripRef.current;
    const card = cardRefs.current[0];
    if (!el || !card) return;
    el.scrollTop = Math.round(
      card.offsetTop - (el.clientHeight - card.offsetHeight) / 2,
    );
    recomputeActive();
  }, [posts.length, recomputeActive]);

  // When images finish classifying their aspect bucket, card heights
  // change. The active card's CENTRE shifts vertically (a portrait
  // that becomes a landscape drops from 200px below offsetTop down to
  // ~83px — its centre moves up by ~117px), so the scroll position
  // we set during initial centring is no longer correct. Re-fire
  // scrollIntoView for the active card, then recomputeActive so per-
  // card opacities match the new layout. Both happen in a
  // useLayoutEffect (not useEffect) so the correction lands BEFORE
  // the next paint and the user doesn't see the photo briefly off-
  // centre. Skipped once the user has scrolled — we don't want to
  // yank them mid-scrub if a late image classification fires.
  useLayoutEffect(() => {
    if (userScrolledRef.current) return;
    if (posts.length === 0) return;
    const card = cardRefs.current[activeIdx];
    if (!card) return;
    card.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
    // Same defensive call as Vault: if scrollTop didn't actually
    // change (only cards BELOW the active one shifted), the scroll
    // listener won't fire recomputeActive on its own. Call it
    // explicitly so opacities never lag a frame behind the layout.
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
      stopMomentum();
      const card = cardRefs.current[idx];
      if (!card) return;
      // Arrow / card-tap navigation also counts as "user is driving" —
      // once they've nudged the strip we stop our settling-time
      // auto-recentre on aspect classification.
      userScrolledRef.current = true;
      setSnapped(false);
      card.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    },
    [stopMomentum, setSnapped],
  );

  // When a card's bucket changes (image finished classifying), the
  // active card's offsetTop shifts and the strip subtly drifts off
  // centre. Snap it back instantly — but only during the settling
  // phase, before the user touches the strip. Once they scroll, this
  // effect short-circuits and stays out of their way.
  useLayoutEffect(() => {
    if (userScrolledRef.current) return;
    if (posts.length === 0) return;
    const card = cardRefs.current[activeIdx];
    if (!card) return;
    card.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
  }, [aspects, activeIdx, posts.length]);

  const active = posts[activeIdx];
  const activeOwner = active ? owners[active.ownerAddress] : null;
  const activeName = useMemo(() => {
    if (!active) return "";
    return (
      activeOwner?.displayName ??
      activeOwner?.ansName ??
      truncate(active.ownerAddress)
    );
  }, [active, activeOwner]);
  const date = useMemo(
    () => (active ? formatDate(active.createdAt) : null),
    [active],
  );

  if (posts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <p
          style={{ fontFamily: "var(--font-display)" }}
          className="text-3xl text-[var(--color-ink)]"
        >
          Quiet here.
        </p>
        <p className="mt-3 max-w-sm text-sm text-[var(--color-mute)]">
          Follow some accounts and their memories will surface here.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex w-full flex-1 flex-col">
      {/* TOP REGION — wheel listener attached here. Strip and every overlay */}
      {/* live as siblings of it, so wheel events bubble up to the handler   */}
      {/* no matter where the user wheels.                                    */}
      <div ref={topRegionRef} className="relative min-h-0 flex-1">
        {/* SIDE TEXT — date / weekday / avatar+name. Sits to the left of    */}
        {/* the ruler, vertically centred, and slides in horizontally from   */}
        {/* the left on every active-card change. Hidden below lg (1024px)   */}
        {/* because calc(50% - 400px) would push it off the left edge.        */}
        <div
          className="pointer-events-none absolute top-1/2 z-10 hidden -translate-y-1/2 lg:block"
          style={{ left: `calc(50% - ${SIDE_TEXT_LEFT}px)`, width: "170px" }}
        >
          <AnimatePresence mode="wait">
            {active && date && (
              <motion.div
                key={active.postId}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-auto flex flex-col gap-1.5"
              >
                <h1
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-2xl tracking-tight text-[var(--color-ink)]"
                >
                  {date.day} {date.month} {date.year}
                </h1>
                <p className="text-xs text-[var(--color-mute)]">
                  {date.weekday}
                </p>
                <Link
                  href={`/u/${active.ownerAddress}`}
                  className="mt-2 flex items-center gap-2 text-[var(--color-mute)] transition hover:text-[var(--color-ink)]"
                >
                  <div className="h-5 w-5 overflow-hidden rounded-full bg-[var(--color-whisper)]">
                    <AvatarImage
                      src={
                        activeOwner?.avatarBlobName
                          ? blobUrl(
                              active.ownerAddress,
                              activeOwner.avatarBlobName,
                            )
                          : null
                      }
                      className="h-full w-full object-cover"
                      fallback={null}
                    />
                  </div>
                  <span className="text-xs">{activeName}</span>
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* RULER-V — hugs the photo column's left edge. Same V-fade mask    */}
        {/* as the photo strip so its ticks taper into the paper.            */}
        <div
          className="ruler-draw pointer-events-none absolute inset-y-0 hidden sm:block"
          style={{
            left: `calc(50% - ${RULER_LEFT}px)`,
            width: `${RULER_W}px`,
          }}
        >
          <div
            className="ruler-v h-full"
            style={{
              WebkitMaskImage: FADE_MASK,
              maskImage: FADE_MASK,
            }}
          />
        </div>

        {/* PIN — centred on the ruler-v centreline (extends equally left   */}
        {/* and right). Right end carries the chevron that points at the    */}
        {/* active photo. Grows the moment the strip locks onto a card.     */}
        <div
          className="pointer-events-none absolute top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 sm:flex sm:items-center sm:justify-center"
          style={{ left: `calc(50% - ${RULER_CENTRE}px)` }}
        >
          <div
            className="ruler-pin-h"
            style={{
              width: isSnapped ? 48 : 24,
              transition:
                "width 280ms var(--ease-paper), background-color 280ms var(--ease-paper)",
            }}
          >
            <svg
              aria-hidden
              width="6"
              height="10"
              viewBox="0 0 6 10"
              fill="none"
              className="ruler-pin-h__tip"
              style={{
                opacity: isSnapped ? 1 : 0,
                transform: `translateY(-50%) translateX(${isSnapped ? 0 : -3}px)`,
                transition:
                  "opacity 220ms var(--ease-paper), transform 220ms var(--ease-paper)",
              }}
            >
              <path
                d="M1 1L5 5L1 9"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* STRIP — absolute, fills the top region exactly. The vertical
            V-fade USED to live here as a `mask-image: linear-gradient`,
            but a pixel-space mask trimmed the top and bottom of every
            tall card (portraits especially: a 320×400 card on a ~900px
            viewport rendered at ~55% alpha at its top and bottom
            edges). The fade now lives on each card individually,
            written from recomputeActive based on the card's centre
            distance from the viewport centre — see the loop in that
            callback. The ruler-v above still carries its own mask so
            its ticks taper at the strip ends; that one's decorative
            and doesn't paint over photos. */}
        <div
          ref={stripRef}
          className="no-scrollbar paper-rise absolute inset-0 overflow-y-auto overflow-x-hidden"
          style={{
            overscrollBehavior: "contain",
          }}
        >
          <div
            className="flex flex-col items-center"
            style={{
              paddingTop: "50vh",
              paddingBottom: "50vh",
              gap: `${GAP}px`,
            }}
          >
            {posts.map((p, i) => {
              // Default to portrait until the image classifies — most
              // uploads are portrait so the visible jump on load is
              // smallest for the common case. Height animates smoothly
              // between buckets thanks to the aspect-ratio transition.
              const aspect = aspects[p.postId] ?? "portrait";
              return (
                <article
                  key={p.postId}
                  ref={cardRefSetters[i]}
                  className="photo-card flex shrink-0 cursor-pointer"
                  style={{
                    width: `min(90vw, ${CARD_W}px)`,
                    aspectRatio: ASPECT_RATIO_CSS[aspect],
                    // No aspect-ratio transition on purpose. See the
                    // comment on `.photo-card` in globals.css — animating
                    // the height over 380ms left the active photo drifting
                    // above the centre pin, because the React re-centre
                    // fired synchronously against the OLD (mid-animation)
                    // offsetHeight and never re-fired after the CSS
                    // animation completed. Snap is correct, smooth was a
                    // visual bug.
                  }}
                  onClick={() => scrollToIdx(i)}
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
                </article>
              );
            })}

            {hasMore && (
              <div ref={sentinelRef} className="h-8 w-px" aria-hidden />
            )}
            {loadingMore && (
              <p className="pb-4 text-xs text-[var(--color-mute)]">
                Loading more…
              </p>
            )}
          </div>
        </div>
      </div>

      {/* BOTTOM STRIP — just the up/down arrows, paired in the centre. The */}
      {/* date / avatar block lives on the left side now, beside the photo. */}
      <div className="flex w-full items-center justify-center gap-12 pb-10 pt-4">
        <button
          type="button"
          onClick={() => scrollToIdx(Math.max(0, activeIdx - 1))}
          disabled={activeIdx === 0}
          className="text-[var(--color-ink)] transition disabled:opacity-25"
          aria-label="Newer memory"
        >
          <svg width="14" height="28" viewBox="0 0 14 28" fill="none">
            <path
              d="M3 8L7 4L11 8M7 4V26"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={() =>
            scrollToIdx(Math.min(posts.length - 1, activeIdx + 1))
          }
          disabled={activeIdx === posts.length - 1}
          className="text-[var(--color-ink)] transition disabled:opacity-25"
          aria-label="Older memory"
        >
          <svg width="14" height="28" viewBox="0 0 14 28" fill="none">
            <path
              d="M3 20L7 24L11 20M7 24V2"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
