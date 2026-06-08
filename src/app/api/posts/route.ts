import { NextResponse } from "next/server";
import { z } from "zod";
import {
  canonicalAddress,
  probeBlobMetadata,
  verifyDeleteBlobTx,
  verifyRegisterBlobTx,
} from "@/lib/aptos-server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Aptos addresses are lowercase 0x-prefixed hex strings of arbitrary length
// (canonical form is 64 hex chars, but short forms exist for genesis accounts).
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((s) => s.toLowerCase());

const VisibilitySchema = z.enum(["PRIVATE", "FOLLOWERS", "PUBLIC"]);

const CreatePostSchema = z.object({
  ownerAddress: Address,
  blobName: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  size: z.number().int().positive(),
  visibility: VisibilitySchema,
  tag: z.string().min(1).max(40).optional(),
  caption: z.string().max(280).optional(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]+$/),
  expirationMicros: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
});

function serializePost(p: {
  postId: string;
  ownerAddress: string;
  blobName: string;
  contentHash: string | null;
  size: number;
  visibility: "PRIVATE" | "FOLLOWERS" | "PUBLIC";
  tag: string | null;
  caption: string | null;
  txHash: string;
  expirationMicros: bigint;
  createdAt: Date;
}) {
  return {
    ...p,
    expirationMicros: p.expirationMicros.toString(),
    createdAt: p.createdAt.toISOString(),
  };
}

export async function POST(req: Request) {
  // 1) Require an authenticated SIWA session. Without this anyone could POST
  //    arbitrary ownerAddress values and attribute spam to other wallets.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = CreatePostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // 2) Session address must match the claimed ownerAddress. Compare canonically
  //    in case one side used a short-form address and the other a long-form.
  let sessionAddr: string;
  let ownerAddr: string;
  try {
    sessionAddr = canonicalAddress(session.address);
    ownerAddr = canonicalAddress(data.ownerAddress);
  } catch {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }
  if (sessionAddr !== ownerAddr) {
    return NextResponse.json(
      { error: "forbidden_owner_mismatch" },
      { status: 403 },
    );
  }

  // 3) Verify the on-chain register_blob tx actually exists, succeeded, was
  //    sent by `ownerAddress`, and registered the same blobName. This is the
  //    authoritative check — even if the session were somehow forged.
  const v = await verifyRegisterBlobTx({
    txHash: data.txHash,
    expectedSender: data.ownerAddress,
    expectedBlobName: data.blobName,
  });
  if (!v.ok) {
    return NextResponse.json(
      { error: "tx_verification_failed", reason: v.reason },
      { status: 400 },
    );
  }

  // Auto-create profile row if missing; the wallet address is the identity.
  await prisma.profile.upsert({
    where: { address: data.ownerAddress },
    update: {},
    create: { address: data.ownerAddress },
  });

  try {
    const post = await prisma.postCache.create({
      data: {
        ownerAddress: data.ownerAddress,
        blobName: data.blobName,
        contentHash: data.contentHash,
        size: data.size,
        visibility: data.visibility,
        tag: data.visibility === "PUBLIC" ? data.tag ?? null : null,
        caption: data.caption,
        txHash: data.txHash,
        expirationMicros: data.expirationMicros,
      },
    });
    return NextResponse.json({ post: serializePost(post) }, { status: 201 });
  } catch (e: unknown) {
    // P2002 = unique constraint (we have @@unique on [ownerAddress, blobName])
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "post_already_exists" },
        { status: 409 },
      );
    }
    console.error("posts POST failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

// Two valid shapes for DELETE:
//
//   { postId, txHash }     — normal path. Client signed and submitted
//                            delete_blob on-chain; we verify the tx
//                            then drop the cache row.
//
//   { postId, force: true } — recovery path. The blob's on-chain
//                            metadata is already gone (typically after
//                            a Shelbynet state reset), so no
//                            delete_blob can ever succeed. Server
//                            re-confirms the blob really is missing via
//                            a view function, then drops the row.
const DeletePostSchema = z.union([
  z.object({
    postId: z.string().uuid(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }),
  z.object({
    postId: z.string().uuid(),
    force: z.literal(true),
  }),
]);

export async function DELETE(req: Request) {
  // 1) Same auth + ownership story as POST. The session address is the
  //    source of truth — we never trust an ownerAddress field in the body.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = DeletePostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const postId = data.postId;

  // 2) Find the post. 404 (not 403) when missing so we don't leak which
  //    postIds exist server-side.
  const post = await prisma.postCache.findUnique({ where: { postId } });
  if (!post) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let sessionAddr: string;
  let ownerAddr: string;
  try {
    sessionAddr = canonicalAddress(session.address);
    ownerAddr = canonicalAddress(post.ownerAddress);
  } catch {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }
  if (sessionAddr !== ownerAddr) {
    return NextResponse.json(
      { error: "forbidden_owner_mismatch" },
      { status: 403 },
    );
  }

  // 3) Branch on which body shape we got.
  if ("txHash" in data) {
    // Normal path — verify the on-chain delete tx.
    const v = await verifyDeleteBlobTx({
      txHash: data.txHash,
      expectedSender: post.ownerAddress,
      expectedBlobName: post.blobName,
    });
    if (!v.ok) {
      return NextResponse.json(
        { error: "tx_verification_failed", reason: v.reason },
        { status: 400 },
      );
    }
  } else {
    // Recovery path — only allow if the blob really is gone on-chain.
    // We never trust the client's `force` claim; we re-verify here so
    // a malicious caller can't strip alive blobs from their own index
    // by sneaking a `force: true`.
    let probe: { alive: boolean };
    try {
      probe = await probeBlobMetadata({
        ownerAddress: post.ownerAddress,
        blobName: post.blobName,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: "probe_failed", reason: msg.slice(0, 200) },
        { status: 502 },
      );
    }
    if (probe.alive) {
      return NextResponse.json(
        { error: "blob_still_alive_use_tx_path" },
        { status: 409 },
      );
    }
  }

  try {
    await prisma.postCache.delete({ where: { postId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("posts DELETE failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "missing_owner" }, { status: 400 });
  }
  const addr = Address.safeParse(owner);
  if (!addr.success) {
    return NextResponse.json({ error: "invalid_owner" }, { status: 400 });
  }
  const targetAddress = addr.data;

  // Visibility filtering by viewer relationship:
  // own → all, follower → PUBLIC+FOLLOWERS, stranger → PUBLIC only.
  const session = await getSession();
  const isOwn = session?.address === targetAddress;
  let isFollower = false;
  if (session && !isOwn) {
    const row = await prisma.follow.findUnique({
      where: {
        followerAddress_followeeAddress: {
          followerAddress: session.address,
          followeeAddress: targetAddress,
        },
      },
    });
    isFollower = row?.status === "ACTIVE";
  }
  const allowed: Array<"PRIVATE" | "FOLLOWERS" | "PUBLIC"> = isOwn
    ? ["PRIVATE", "FOLLOWERS", "PUBLIC"]
    : isFollower
      ? ["FOLLOWERS", "PUBLIC"]
      : ["PUBLIC"];

  const posts = await prisma.postCache.findMany({
    where: { ownerAddress: targetAddress, visibility: { in: allowed } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ posts: posts.map(serializePost) });
}
