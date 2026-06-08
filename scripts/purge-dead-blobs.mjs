// One-time cleanup: drop PostCache rows whose Shelby BYTES are gone,
// even when the on-chain blob_metadata is still alive. Different failure
// mode from `purge-ghost-blobs.mjs`: that one catches state resets where
// the contract was redeployed; this one catches the bytes-only data loss
// that happens periodically on Shelbynet (metadata survives, blob does
// not). When that happens our UI shows broken-image placeholders because
// the proxy faithfully forwards Shelby's 404.
//
// We probe by actually issuing a download through the SDK — the same
// call /api/blob/[address]/[...blobName] makes — so this script's "dead"
// label is exactly what users see in the browser. A row is purged only
// after RETRIES consecutive failures, to avoid nuking rows for transient
// network blips.
//
// Dry-run (default — only lists what would go):
//   node --env-file=.env scripts/purge-dead-blobs.mjs
//
// To actually delete: add --yes
//   node --env-file=.env scripts/purge-dead-blobs.mjs --yes

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { AccountAddress, Network } from "@aptos-labs/ts-sdk";
import { ShelbyClient } from "@shelby-protocol/sdk/node";

const YES = process.argv.includes("--yes");
const CONCURRENCY = 8;
const RETRIES = 2; // probe RETRIES + 1 times before declaring dead

const connectionString = process.env.DATABASE_URL;
const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY ?? "";
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const shelby = new ShelbyClient({
  network: Network.SHELBYNET,
  apiKey,
  aptos: {
    network: Network.SHELBYNET,
    clientConfig: { API_KEY: apiKey },
  },
});

async function probeOnce(ownerAddress, blobName) {
  try {
    const blob = await shelby.download({
      account: AccountAddress.fromString(ownerAddress),
      blobName,
    });
    // We don't need the bytes — but we DO need to drain the stream so
    // the underlying connection is released back to the pool. Otherwise
    // we'd leak sockets through the loop.
    const reader = blob.readable.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return "alive";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|404/i.test(msg)) return "dead";
    return `unknown:${msg.slice(0, 80)}`;
  }
}

async function probe(ownerAddress, blobName) {
  // Re-probe up to RETRIES times if we see anything other than a clear
  // 404. We DON'T retry on dead — a 404 is decisive, and a flapping
  // gateway that occasionally returns the bytes will be caught on the
  // alive=yes branch.
  let lastStatus = null;
  for (let i = 0; i <= RETRIES; i++) {
    const s = await probeOnce(ownerAddress, blobName);
    if (s === "alive") return "alive";
    if (s === "dead") return "dead";
    lastStatus = s;
  }
  return lastStatus ?? "unknown";
}

// Bounded-concurrency map. Keeps memory + connections sane on bigger
// tables without pulling in p-limit.
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const posts = await prisma.postCache.findMany({
  orderBy: { createdAt: "desc" },
  select: { postId: true, ownerAddress: true, blobName: true, createdAt: true },
});

console.log(`probing ${posts.length} PostCache row(s) (concurrency ${CONCURRENCY})…`);

let aliveN = 0;
let deadN = 0;
let unknownN = 0;
const dead = [];
const unknown = [];

await mapPool(posts, CONCURRENCY, async (p) => {
  const status = await probe(p.ownerAddress, p.blobName);
  if (status === "alive") aliveN++;
  else if (status === "dead") {
    deadN++;
    dead.push(p);
  } else {
    unknownN++;
    unknown.push({ ...p, status });
  }
});

console.log(`\nsummary: alive=${aliveN} dead=${deadN} unknown=${unknownN}`);

if (unknown.length) {
  console.log(`\n${unknown.length} row(s) with inconclusive probes — NOT deleting:`);
  for (const u of unknown.slice(0, 10)) {
    console.log(`  ${u.createdAt.toISOString().slice(0, 19)}  ${u.blobName}  ${u.status}`);
  }
  if (unknown.length > 10) console.log(`  …and ${unknown.length - 10} more`);
}

console.log(`\nFound ${dead.length} dead row(s):`);
for (const d of dead.slice(0, 20)) {
  console.log(`  ${d.createdAt.toISOString().slice(0, 19)}  ${d.blobName}`);
}
if (dead.length > 20) console.log(`  …and ${dead.length - 20} more`);

if (dead.length === 0) {
  console.log("\nNothing to purge.");
  await prisma.$disconnect();
  process.exit(0);
}

if (!YES) {
  console.log("\nDry-run. Re-run with --yes to delete these rows.");
  await prisma.$disconnect();
  process.exit(0);
}

const ids = dead.map((g) => g.postId);
const result = await prisma.postCache.deleteMany({
  where: { postId: { in: ids } },
});
console.log(`\nDeleted ${result.count} row(s).`);
await prisma.$disconnect();
