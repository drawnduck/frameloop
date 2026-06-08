// Diagnostic: for every cached post, ask Shelbynet whether the blob's
// on-chain metadata still exists. Three possible findings:
//
//   alive    — metadata present; the storage nodes might still have data
//   missing  — metadata gone on-chain (testnet reset, or owner deleted it)
//   error    — network or RPC error talking to Aptos
//
// Run:
//   node -r dotenv/config scripts/check-onchain.mjs \
//        dotenv_config_path=.env.local

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
  select: { ownerAddress: true, blobName: true, createdAt: true, txHash: true },
});

console.log(`checking ${posts.length} posts against Shelbynet on-chain state\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad("createdAt", 22),
  pad("status", 14),
  pad("txOnChain", 12),
  "blobName",
);
console.log("─".repeat(115));

let aliveBlobs = 0;
let missingBlobs = 0;
let txOk = 0;
let txGone = 0;

for (const p of posts) {
  // Two independent queries: (1) does register_blob tx still exist in
  // the ledger? (2) does the blob metadata resource still exist?
  // If (1) is gone but (2) is gone too → testnet was reset.
  // If (1) is still there but (2) is gone → blob was deleted on-chain
  // (legitimate delete_blob landed) or pruned.
  let txStatus = "?";
  try {
    const tx = await aptos.getTransactionByHash({ transactionHash: p.txHash });
    txStatus = tx.type === "user_transaction" ? "ok" : tx.type;
    if (txStatus === "ok") txOk++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    txStatus = msg.includes("404") || msg.includes("not found") ? "GONE" : "err";
    if (txStatus === "GONE") txGone++;
  }

  let blobStatus = "?";
  try {
    // The SDK's createBlobKey: "@<long-addr-without-0x>/<blobName>"
    const addr = AccountAddress.from(p.ownerAddress, { maxMissingChars: 63 });
    const blobKey = `@${addr.toStringLongWithoutPrefix()}/${p.blobName}`;
    const rawMetadata = await aptos.view({
      payload: {
        function: `${SHELBY_DEPLOYER}::blob_metadata::get_blob_metadata`,
        functionArguments: [blobKey],
      },
    });
    // Returns Option<BlobMetadata>: [{ vec: [data] }] when present,
    // [{ vec: [] }] when missing.
    const present = !!rawMetadata?.[0]?.vec?.[0];
    blobStatus = present ? "alive" : "MISSING";
    if (present) aliveBlobs++;
    else missingBlobs++;
  } catch (e) {
    blobStatus = "err";
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.length < 80) blobStatus = `err: ${msg.slice(0, 60)}`;
  }

  console.log(
    pad(p.createdAt.toISOString().slice(0, 19), 22),
    pad(blobStatus, 14),
    pad(txStatus, 12),
    p.blobName,
  );
}

console.log(
  `\non-chain blobs: ${aliveBlobs} alive, ${missingBlobs} missing`,
);
console.log(
  `register_blob txs: ${txOk} still indexed, ${txGone} gone from ledger`,
);
await prisma.$disconnect();
