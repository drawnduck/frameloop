// One-time cleanup: drop PostCache rows whose on-chain blob_metadata
// is missing (typically because Shelbynet wiped contract state via a
// module redeploy). The UI now self-heals via the `force: true` DELETE
// path, but this script lets you mass-clear ghost rows without having
// to double-click each one in the Vault.
//
// Run (dry-run by default — only lists what would go):
//   node -r dotenv/config scripts/purge-ghost-blobs.mjs \
//        dotenv_config_path=.env.local
//
// To actually delete: add --yes
//   node -r dotenv/config scripts/purge-ghost-blobs.mjs \
//        dotenv_config_path=.env.local --yes

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  Aptos,
  AptosConfig,
  Network,
  AccountAddress,
} from "@aptos-labs/ts-sdk";

const SHELBY_DEPLOYER =
  "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";
const YES = process.argv.includes("--yes");

const connectionString = process.env.DATABASE_URL;
const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY;
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const aptos = new Aptos(
  new AptosConfig({
    network: Network.SHELBYNET,
    ...(apiKey ? { clientConfig: { API_KEY: apiKey } } : {}),
  }),
);

const posts = await prisma.postCache.findMany({
  orderBy: { createdAt: "desc" },
  select: { postId: true, ownerAddress: true, blobName: true, createdAt: true },
});

const ghosts = [];
for (const p of posts) {
  try {
    const addr = AccountAddress.from(p.ownerAddress, { maxMissingChars: 63 });
    const blobKey = `@${addr.toStringLongWithoutPrefix()}/${p.blobName}`;
    const raw = await aptos.view({
      payload: {
        function: `${SHELBY_DEPLOYER}::blob_metadata::get_blob_metadata`,
        functionArguments: [blobKey],
      },
    });
    const alive = !!raw?.[0]?.vec?.[0];
    if (!alive) ghosts.push(p);
  } catch (e) {
    // Skip rows we can't probe — they might be alive or the RPC
    // hiccupped. Better to under-delete than over-delete.
    console.warn(
      `probe failed for ${p.blobName}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

console.log(`\nFound ${ghosts.length} ghost row(s):`);
for (const g of ghosts) {
  console.log(`  ${g.createdAt.toISOString().slice(0, 19)}  ${g.blobName}`);
}

if (ghosts.length === 0) {
  console.log("\nNothing to purge.");
  await prisma.$disconnect();
  process.exit(0);
}

if (!YES) {
  console.log("\nDry-run. Re-run with --yes to delete these rows.");
  await prisma.$disconnect();
  process.exit(0);
}

const ids = ghosts.map((g) => g.postId);
const result = await prisma.postCache.deleteMany({
  where: { postId: { in: ids } },
});
console.log(`\nDeleted ${result.count} row(s).`);
await prisma.$disconnect();
