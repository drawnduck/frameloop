// One-time cleanup: clear Profile.avatarBlobName for entries whose Shelby
// BYTES are gone (even when on-chain metadata is still alive). Sibling
// script to `purge-dead-blobs.mjs` — same root cause (Shelbynet bytes
// disappearing), different table.
//
// See purge-dead-blobs.mjs for a detailed explanation of why "dead"
// (bytes-gone) is distinct from "ghost" (metadata-gone) and why we
// retry inconclusive probes but not 404s.
//
// Dry-run (default):
//   node --env-file=.env scripts/purge-dead-avatars.mjs
//
// Actually clear:
//   node --env-file=.env scripts/purge-dead-avatars.mjs --yes

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { AccountAddress, Network } from "@aptos-labs/ts-sdk";
import { ShelbyClient } from "@shelby-protocol/sdk/node";

const YES = process.argv.includes("--yes");
const CONCURRENCY = 8;
const RETRIES = 2;

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
  aptos: { network: Network.SHELBYNET, clientConfig: { API_KEY: apiKey } },
});

async function probeOnce(ownerAddress, blobName) {
  try {
    const blob = await shelby.download({
      account: AccountAddress.fromString(ownerAddress),
      blobName,
    });
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
  let lastStatus = null;
  for (let i = 0; i <= RETRIES; i++) {
    const s = await probeOnce(ownerAddress, blobName);
    if (s === "alive") return "alive";
    if (s === "dead") return "dead";
    lastStatus = s;
  }
  return lastStatus ?? "unknown";
}

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

const profiles = await prisma.profile.findMany({
  where: { avatarBlobName: { not: null } },
  select: { address: true, avatarBlobName: true, displayName: true },
});

console.log(`probing ${profiles.length} avatar(s) (concurrency ${CONCURRENCY})…`);

let aliveN = 0;
let deadN = 0;
let unknownN = 0;
const dead = [];
const unknown = [];

await mapPool(profiles, CONCURRENCY, async (p) => {
  const status = await probe(p.address, p.avatarBlobName);
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
  console.log(`\n${unknown.length} avatar(s) with inconclusive probes — NOT clearing:`);
  for (const u of unknown.slice(0, 10)) {
    console.log(`  ${u.displayName ?? "(no name)"}  ${u.address}  ${u.status}`);
  }
  if (unknown.length > 10) console.log(`  …and ${unknown.length - 10} more`);
}

console.log(`\nFound ${dead.length} dead avatar(s):`);
for (const d of dead.slice(0, 20)) {
  console.log(`  ${d.displayName ?? "(no name)"}  ${d.address}  ${d.avatarBlobName}`);
}
if (dead.length > 20) console.log(`  …and ${dead.length - 20} more`);

if (dead.length === 0) {
  console.log("\nNothing to clear.");
  await prisma.$disconnect();
  process.exit(0);
}

if (!YES) {
  console.log("\nDry-run. Re-run with --yes to null these avatarBlobName fields.");
  await prisma.$disconnect();
  process.exit(0);
}

const addrs = dead.map((g) => g.address);
const result = await prisma.profile.updateMany({
  where: { address: { in: addrs } },
  data: { avatarBlobName: null },
});
console.log(`\nCleared ${result.count} avatarBlobName field(s).`);
await prisma.$disconnect();
