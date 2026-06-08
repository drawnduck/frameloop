"use client";

/**
 * Avatar image with a graceful fallback when the source 404s.
 *
 * Why this exists: Shelby blobs can vanish behind the back of the
 * database — TTL expiry, devnet state resets, storage-node loss — and
 * when they do, our cached `avatarBlobName` still points at them. A
 * raw `<img>` then renders the browser's "broken image" glyph, which
 * looks like a bug.
 *
 * This component:
 *   • renders the fallback when `src` is null,
 *   • renders the fallback when the image errors at load time,
 *   • re-attempts when `src` changes (e.g. user uploads a new avatar
 *     mid-session — previous error state shouldn't sticky-block it).
 *
 * The fallback is a ReactNode so callers can render the per-page
 * voice — a wordmark "M" in the chrome, the address slug "0xab" on
 * a profile row, etc.
 */

import { useEffect, useState } from "react";
import type { ImgHTMLAttributes, ReactNode } from "react";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string | null;
  /** Always set, even when src is null — that's exactly when we need it. */
  fallback: ReactNode;
  /** Optional — alt text on the image when it does load. Empty by default. */
  alt?: string;
};

export function AvatarImage({ src, fallback, alt = "", ...rest }: Props) {
  const [errored, setErrored] = useState(false);

  // Reset error state when the source URL actually changes. Without
  // this, an old error would stick and block a freshly uploaded
  // avatar from rendering.
  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (!src || errored) {
    return <>{fallback}</>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setErrored(true)}
      {...rest}
    />
  );
}
