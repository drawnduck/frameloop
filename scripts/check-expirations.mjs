// One-off diagnostic: which cached posts have already expired on-chain?
//
// Run:
//   node -r dotenv/config scripts/check-expirations.mjs \
//        dotenv_config_path=.env.local

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL not set — pass via -r dotenv/config + dotenv_config_path=.env.local",
  );
  process.exit(1);
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const nowMicros = BigInt(Date.now()) * 1000n;

const posts = await prisma.postCache.findMany({
  orderBy: { createdAt: "desc" },
  select: {
    postId: true,
    ownerAddress: true,
    blobName: true,
    createdAt: true,
    expirationMicros: true,
    visibility: true,
  },
});

console.log(`now: ${new Date(Number(nowMicros / 1000n)).toISOString()}`);
console.log(`posts in cache: ${posts.length}\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad("createdAt", 22),
  pad("expiresAt", 22),
  pad("status", 12),
  pad("vis", 10),
  "blobName",
);
console.log("─".repeat(115));

let expired = 0;
let alive = 0;
for (const p of posts) {
  const expMs = Number(p.expirationMicros / 1000n);
  const expDate = new Date(expMs);
  const isExpired = p.expirationMicros <= nowMicros;
  if (isExpired) expired++;
  else alive++;
  const ttlDaysFromCreation = Math.round(
    (expMs - p.createdAt.getTime()) / 86_400_000,
  );
  console.log(
    pad(p.createdAt.toISOString().slice(0, 19), 22),
    pad(expDate.toISOString().slice(0, 19), 22),
    pad(isExpired ? "EXPIRED" : `~${ttlDaysFromCreation}d ttl`, 12),
    pad(p.visibility, 10),
    p.blobName,
  );
}

console.log(`\nsummary: ${alive} alive, ${expired} expired`);
await prisma.$disconnect();
