"use client";

/**
 * PhotoCropper — Instagram-style aspect cropping in paper aesthetic.
 *
 *  ┌─ Square  Portrait  Landscape ─┐
 *  │                               │
 *  │     ┌─────────────────────┐   │   ← square envelope (fixed size)
 *  │     │                     │   │     inner frame is inscribed in
 *  │     │   inscribed frame   │   │     this envelope based on the
 *  │     │   (varies by mode)  │   │     chosen aspect — Square fills,
 *  │     │                     │   │     Portrait is narrower, Landscape
 *  │     └─────────────────────┘   │     is shorter. The outer rect
 *  │                               │     never changes, so neighbours
 *  │   ── zoom ─────────────────── │     in the page don't reflow.
 *  └───────────────────────────────┘
 *
 *  Why an envelope: switching aspect would otherwise resize the whole
 *  cropper and shove the rest of the upload form up or down. Anchoring
 *  the outer size means only the inner crop window changes — the page
 *  feels monolithic.
 *
 *  About vertical-stretching: previously we set `width` AND `height`
 *  inline on the <img>. Tailwind's preflight also applies
 *  `img { max-width: 100% }` which clamps width when zoomed past 1×;
 *  the inline height stayed at the un-clamped value and produced a
 *  visibly stretched picture. We now set only `width` (height auto-
 *  derives from natural aspect) and explicitly `maxWidth: "none"` to
 *  defeat the preflight rule. Aspect is preserved by the browser at
 *  every zoom level.
 *
 *  Drag-to-pan and zoom (slider + mouse wheel) are unchanged from the
 *  prior version; the imperative `getCroppedFile` still renders to a
 *  canvas at canonical IG resolution.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CropAspect = "square" | "portrait" | "landscape";

export type CropperHandle = {
  /** Render the current crop to a canvas and return as a JPEG File. */
  getCroppedFile: () => Promise<File>;
  /** The aspect bucket currently selected. */
  getAspect: () => CropAspect;
};

/** Width / height of each aspect bucket. Mirrors PoolStack.ASPECT_DIMS. */
const ASPECT_RATIO: Record<CropAspect, number> = {
  square: 1,
  portrait: 4 / 5,
  landscape: 1.91,
};

/** Canonical output dimensions. Width × height — landscape is short. */
const OUTPUT_DIMS: Record<CropAspect, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  landscape: { w: 1080, h: 566 },
};

const ASPECT_TABS: readonly { value: CropAspect; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
] as const;

type Props = {
  /** Source image file the user just picked / dropped. */
  file: File;
  /** Notified whenever the user picks a different aspect bucket. */
  onAspectChange?: (a: CropAspect) => void;
};

export const PhotoCropper = forwardRef<CropperHandle, Props>(
  function PhotoCropper({ file, onAspectChange }, ref) {
    const [aspect, setAspect] = useState<CropAspect>("square");
    const [scale, setScale] = useState(1);
    const [pos, setPos] = useState({ x: 0, y: 0 });

    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(
      null,
    );

    // The envelope is the FIXED outer rect — a square whose width tracks
    // its grid column. Its size never depends on aspect, so switching
    // aspect can't shove the form alongside it.
    const envelopeRef = useRef<HTMLDivElement | null>(null);
    const [envelopeW, setEnvelopeW] = useState(420);
    const frameElRef = useRef<HTMLDivElement | null>(null);

    // Object URL for the picked file. Revoked on file change so we don't
    // accumulate blob refs over a long session.
    useEffect(() => {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      setImgDims(null);
      setScale(1);
      setPos({ x: 0, y: 0 });
      return () => URL.revokeObjectURL(url);
    }, [file]);

    // Decode the image once to learn its natural pixel dimensions.
    useEffect(() => {
      if (!previewUrl) return;
      const img = new Image();
      img.onload = () => {
        setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.src = previewUrl;
    }, [previewUrl]);

    // Track the envelope's measured width so the math scales with the
    // user's viewport without a separate set of breakpoints.
    useLayoutEffect(() => {
      const el = envelopeRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 420;
        setEnvelopeW(Math.round(w));
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Inner frame dimensions — inscribed in the square envelope.
    //   r >= 1 (square / landscape): width = envelope, height shrinks
    //   r <  1 (portrait):           height = envelope, width shrinks
    const frameDims = useMemo(() => {
      const r = ASPECT_RATIO[aspect];
      if (r >= 1) {
        return { w: envelopeW, h: Math.round(envelopeW / r) };
      }
      return { w: Math.round(envelopeW * r), h: envelopeW };
    }, [envelopeW, aspect]);
    const frameW = frameDims.w;
    const frameH = frameDims.h;

    // "Cover" scale: smallest factor that makes the natural image cover
    // the frame in both dimensions. At slider = 1 we exactly cover.
    const baseScale = useMemo(() => {
      if (!imgDims) return 1;
      return Math.max(frameW / imgDims.w, frameH / imgDims.h);
    }, [imgDims, frameW, frameH]);

    const displayW = imgDims ? imgDims.w * baseScale * scale : 0;
    const displayH = imgDims ? imgDims.h * baseScale * scale : 0;

    // Pan limit so the image never reveals any frame edge.
    const limits = useMemo(
      () => ({
        x: Math.max(0, (displayW - frameW) / 2),
        y: Math.max(0, (displayH - frameH) / 2),
      }),
      [displayW, displayH, frameW, frameH],
    );

    const clampPos = useCallback(
      (p: { x: number; y: number }) => ({
        x: Math.max(-limits.x, Math.min(limits.x, p.x)),
        y: Math.max(-limits.y, Math.min(limits.y, p.y)),
      }),
      [limits.x, limits.y],
    );

    // Re-clamp whenever the displayed image's "room to pan" shrinks
    // (aspect switch, zoom out) so the photo never parks outside the
    // frame.
    useEffect(() => {
      setPos((p) => clampPos(p));
    }, [clampPos]);

    // Notify parent when the aspect changes.
    useEffect(() => {
      onAspectChange?.(aspect);
    }, [aspect, onAspectChange]);

    // ── Pointer-driven pan ─────────────────────────────────────────────
    const dragRef = useRef<{
      startX: number;
      startY: number;
      posX: number;
      posY: number;
      pointerId: number;
    } | null>(null);
    const [dragging, setDragging] = useState(false);

    function onPointerDown(e: React.PointerEvent) {
      if (!imgDims) return;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        posX: pos.x,
        posY: pos.y,
        pointerId: e.pointerId,
      };
      setDragging(true);
    }
    function onPointerMove(e: React.PointerEvent) {
      if (!dragRef.current) return;
      const d = dragRef.current;
      setPos(
        clampPos({
          x: d.posX + (e.clientX - d.startX),
          y: d.posY + (e.clientY - d.startY),
        }),
      );
    }
    function endDrag() {
      dragRef.current = null;
      setDragging(false);
    }

    // ── Wheel-driven zoom (passive:false so we can preventDefault) ─────
    useEffect(() => {
      const el = frameElRef.current;
      if (!el) return;
      function onWheel(e: WheelEvent) {
        e.preventDefault();
        setScale((s) => {
          const next = s - e.deltaY * 0.002;
          return Math.max(1, Math.min(3, next));
        });
      }
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, []);

    // ── Imperative crop API ────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        getAspect: () => aspect,
        async getCroppedFile() {
          if (!imgDims || !previewUrl) {
            throw new Error("Image not loaded yet");
          }
          const out = OUTPUT_DIMS[aspect];

          // Decode fresh so we're not coupled to the React lifecycle.
          const img = new Image();
          img.src = previewUrl;
          await img.decode();

          // Map the visible frame back to source-image pixels.
          //   image-display centre = (frameW/2 + pos.x, frameH/2 + pos.y)
          //   so frame-origin in image-display coords =
          //     (displayW/2 - frameW/2 - pos.x,
          //      displayH/2 - frameH/2 - pos.y)
          //   divide by (baseScale * scale) → source-pixel space.
          const k = baseScale * scale;
          const srcX = (displayW / 2 - frameW / 2 - pos.x) / k;
          const srcY = (displayH / 2 - frameH / 2 - pos.y) / k;
          const srcW = frameW / k;
          const srcH = frameH / k;

          const canvas = document.createElement("canvas");
          canvas.width = out.w;
          canvas.height = out.h;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("2D canvas context unavailable");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          // White backstop in case of sub-pixel transparency at the seams.
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, out.w, out.h);
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, out.w, out.h);

          const blob: Blob = await new Promise((res, rej) => {
            canvas.toBlob(
              (b) => (b ? res(b) : rej(new Error("Canvas export failed"))),
              "image/jpeg",
              0.92,
            );
          });

          const stem = file.name.replace(/\.[^.]+$/, "") || "memory";
          return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
        },
      }),
      [
        aspect,
        baseScale,
        scale,
        pos.x,
        pos.y,
        displayW,
        displayH,
        frameW,
        frameH,
        imgDims,
        previewUrl,
        file.name,
      ],
    );

    return (
      <div className="flex w-full flex-col items-center">
        {/* Aspect tabs */}
        <div
          role="tablist"
          aria-label="Crop aspect"
          className="mb-5 flex items-center gap-5"
        >
          {ASPECT_TABS.map((t) => {
            const active = aspect === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setAspect(t.value)}
                className={`aspect-tab${active ? " is-active" : ""}`}
                style={{ fontFamily: "var(--font-display)" }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Envelope — fixed square. Aspect changes only the inscribed
            inner frame, never the envelope itself. */}
        <div
          ref={envelopeRef}
          className="relative w-full"
          style={{ aspectRatio: "1 / 1", maxWidth: 460 }}
        >
          {/* Frame — inscribed in envelope, centred. */}
          <div
            ref={frameElRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute overflow-hidden bg-[var(--color-whisper)] shadow-[0_1px_2px_rgba(20,20,20,.05),0_20px_40px_-12px_rgba(20,20,20,.15)]"
            style={{
              left: "50%",
              top: "50%",
              width: frameW,
              height: frameH,
              transform: "translate(-50%, -50%)",
              touchAction: "none",
              cursor: imgDims ? (dragging ? "grabbing" : "grab") : "progress",
              userSelect: "none",
              // CSS-driven dimension transition so aspect switches feel
              // like the frame "morphs" rather than snap.
              transition:
                "width 360ms var(--ease-paper), height 360ms var(--ease-paper)",
            }}
          >
            {previewUrl && imgDims && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt=""
                draggable={false}
                className="pointer-events-none absolute select-none"
                style={{
                  // ONLY width is set; height derives from natural aspect.
                  // maxWidth: "none" defeats Tailwind preflight's
                  // `img { max-width: 100% }`, which otherwise clamps
                  // a zoomed image to the frame's width and produces a
                  // visibly stretched-vertical render.
                  width: displayW,
                  maxWidth: "none",
                  height: "auto",
                  left: "50%",
                  top: "50%",
                  transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
                }}
              />
            )}

            {/* Rule-of-thirds guides — only while dragging. */}
            <div
              className="pointer-events-none absolute inset-0 transition-opacity duration-200"
              style={{ opacity: dragging ? 1 : 0 }}
            >
              <div className="absolute inset-x-0 top-1/3 border-t border-white/40" />
              <div className="absolute inset-x-0 top-2/3 border-t border-white/40" />
              <div className="absolute inset-y-0 left-1/3 border-l border-white/40" />
              <div className="absolute inset-y-0 left-2/3 border-l border-white/40" />
            </div>
          </div>
        </div>

        {/* Zoom slider */}
        <div className="mt-6 flex w-full max-w-sm items-center gap-3">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-mute)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            zoom
          </span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={scale}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            aria-label="Zoom"
            className="paper-range flex-1"
          />
          <span
            className="w-9 text-right font-mono text-[10px] tabular-nums text-[var(--color-mute)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {scale.toFixed(2)}×
          </span>
        </div>
      </div>
    );
  },
);
