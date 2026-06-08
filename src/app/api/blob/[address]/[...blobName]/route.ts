import { AccountAddress, Network } from "@aptos-labs/ts-sdk";
import { ShelbyClient } from "@shelby-protocol/sdk/node";
import { NextResponse } from "next/server";
import { canonicalAddress } from "@/lib/aptos-server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY ?? "";

let _client: ShelbyClient | null = null;
function getClient() {
  if (_client) return _client;
  _client = new ShelbyClient({
    network: Network.SHELBYNET,
    apiKey,
    aptos: {
      network: Network.SHELBYNET,
      clientConfig: { API_KEY: apiKey },
    },
  });
  return _client;
}

// Proxies a Shelby blob through the server so the browser can <img src> it
// without bundling the API key or running the validating SDK in the browser.
//
// ─── Access control ──────────────────────────────────────────────────────
// Shelby itself stores plaintext bytes and serves them to anyone who asks —
// privacy in this app rests entirely on the proxy. The (ownerAddress,
// blobName) pair is the capability; the blobName carries 128 bits of entropy
// (see newBlobName in src/lib/shelby.ts) so it can't be brute-forced. But
// any pair that *does* leak (URL copy, screenshot of devtools, server log)
// would otherwise hand out the bytes unconditionally.
//
// To close that hole we check the requester against our PostCache index:
//   PUBLIC      → anyone
//   FOLLOWERS   → owner + active followers (must have a signed session)
//   PRIVATE     → owner only (must have a signed session)
//
// Two blobs don't live in PostCache: profile avatars (referenced by
// Profile.avatarBlobName, treated as public — they already surface in
// /api/feed and /api/profiles/search) and freshly-uploaded post blobs
// in the window between Shelby upload and /api/posts commit (allow the
// owner so the upload-page preview keeps working).
//
// Lookups that don't match any of the above return 404 — same response
// as a genuinely missing blob, so the proxy doesn't leak which (address,
// blobName) pairs exist on disk.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ address: string; blobName: string[] }> },
) {
  const { address, blobName: parts } = await ctx.params;
  const blobName = parts.map(decodeURIComponent).join("/");

  let account: AccountAddress;
  let ownerCanonical: string;
  try {
    account = AccountAddress.fromString(address);
    ownerCanonical = canonicalAddress(address);
  } catch {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  // ── Authorize ──────────────────────────────────────────────────────────
  const session = await getSession();
  const viewerCanonical = session ? canonicalAddress(session.address) : null;
  const isOwner = viewerCanonical === ownerCanonical;

  // Default cache directive — overridden to "private" for non-public blobs.
  let cacheControl = "public, max-age=3600, immutable";

  const post = await prisma.postCache.findUnique({
    where: { ownerAddress_blobName: { ownerAddress: ownerCanonical, blobName } },
    select: { visibility: true },
  });

  if (post) {
    if (post.visibility === "PUBLIC") {
      // Anyone may fetch. Keep public cache-control.
    } else if (post.visibility === "FOLLOWERS") {
      if (!isOwner) {
        if (!viewerCanonical) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        const follow = await prisma.follow.findUnique({
          where: {
            followerAddress_followeeAddress: {
              followerAddress: viewerCanonical,
              followeeAddress: ownerCanonical,
            },
          },
          select: { status: true },
        });
        if (follow?.status !== "ACTIVE") {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
      }
      cacheControl = "private, max-age=3600, immutable";
    } else {
      // PRIVATE
      if (!isOwner) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      cacheControl = "private, max-age=3600, immutable";
    }
  } else {
    // Not in PostCache. Allowed cases:
    //   1. It's a profile avatar — public by design.
    //   2. The requester is the owner — covers the upload-page preview
    //      that fires before /api/posts commits the blob to the index.
    // Everything else is 404, indistinguishable from a real miss.
    const isAvatar = await prisma.profile.findFirst({
      where: { address: ownerCanonical, avatarBlobName: blobName },
      select: { address: true },
    });
    if (!isAvatar && !isOwner) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!isAvatar) {
      // Owner previewing their own pre-commit blob — keep it out of shared
      // caches in case the post ends up PRIVATE.
      cacheControl = "private, max-age=3600, immutable";
    }
  }

  try {
    const blob = await getClient().download({ account, blobName });
    return new NextResponse(blob.readable, {
      headers: {
        // The SDK exposes content-length on the ShelbyBlob; the browser handles
        // image type sniffing fine without a specific content-type.
        "content-type": "application/octet-stream",
        "cache-control": cacheControl,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|404/i.test(msg)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error("blob proxy failed:", e);
    return NextResponse.json({ error: "proxy_failed" }, { status: 502 });
  }
}
