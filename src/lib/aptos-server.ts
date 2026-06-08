// Server-side Aptos client + register_blob transaction verifier.
//
// This module is import-safe in route handlers (it's NOT "use client" — keep
// it out of the browser bundle). We use it to confirm that a txHash submitted
// by a client actually corresponds to a successful register_blob call from
// the address the client claims to own.
//
// Without this, /api/posts would trust the client's `ownerAddress` field and
// anyone could pollute someone else's profile by replaying a known txHash.

import {
  AccountAddress,
  Aptos,
  AptosConfig,
  Network,
} from "@aptos-labs/ts-sdk";

// Shelby contract deployer on Shelbynet. Source-of-truth:
//   node_modules/@shelby-protocol/sdk/dist/core/clients/ShelbyBlobClient.mjs
//   (search for `SHELBY_DEPLOYER`)
const SHELBY_DEPLOYER =
  "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";
const REGISTER_BLOB_FN = `${SHELBY_DEPLOYER}::blob_metadata::register_blob`;
const REGISTER_BLOB_SPONSORED_FN = `${SHELBY_DEPLOYER}::blob_metadata::register_blob_with_sponsor`;
const DELETE_BLOB_FN = `${SHELBY_DEPLOYER}::blob_metadata::delete_blob`;

let _aptos: Aptos | null = null;

function getAptosServer(): Aptos {
  if (_aptos) return _aptos;
  // API key isn't a secret on Shelbynet — it's the same one the browser uses —
  // but passing it server-side avoids rate limiting against the public bucket.
  const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY;
  const config = new AptosConfig({
    network: Network.SHELBYNET,
    ...(apiKey ? { clientConfig: { API_KEY: apiKey } } : {}),
  });
  _aptos = new Aptos(config);
  return _aptos;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Canonicalize an Aptos address for safe string comparison. */
function canonical(addr: string): string {
  return AccountAddress.from(addr).toString();
}

/**
 * Verify that `txHash` is a committed, successful register_blob (or sponsored
 * variant) call from `expectedSender` for `expectedBlobName`.
 *
 * On chain, the entry function signature is:
 *   register_blob(blobName: vector<u8>, expirationMicros: u64,
 *                 blobMerkleRoot: vector<u8>, numChunksets: u64,
 *                 blobSize: u64, _unused: u64, encoding: u64)
 * so the first argument is the blobName string.
 */
export async function verifyRegisterBlobTx(args: {
  txHash: string;
  expectedSender: string;
  expectedBlobName: string;
}): Promise<VerifyResult> {
  const aptos = getAptosServer();
  let tx: Awaited<ReturnType<Aptos["getTransactionByHash"]>>;
  try {
    tx = await aptos.getTransactionByHash({ transactionHash: args.txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `tx lookup failed: ${msg}` };
  }

  if (tx.type !== "user_transaction") {
    return {
      ok: false,
      reason: `tx type is ${tx.type}, expected user_transaction`,
    };
  }

  // Pull the fields we need with narrow typing — the SDK's TransactionResponse
  // union includes pending/genesis/etc. variants that don't have `success` or
  // `sender`, but we've already checked the type discriminator above.
  const utx = tx as unknown as {
    success: boolean;
    sender: string;
    payload?: {
      function?: string;
      arguments?: unknown[];
    };
  };

  if (!utx.success) {
    return { ok: false, reason: "tx not successful on chain" };
  }

  let senderNorm: string;
  let expectedNorm: string;
  try {
    senderNorm = canonical(utx.sender);
    expectedNorm = canonical(args.expectedSender);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `bad address: ${msg}` };
  }
  if (senderNorm !== expectedNorm) {
    return {
      ok: false,
      reason: `tx sender ${senderNorm} != claimed owner ${expectedNorm}`,
    };
  }

  const fnId = utx.payload?.function;
  if (fnId !== REGISTER_BLOB_FN && fnId !== REGISTER_BLOB_SPONSORED_FN) {
    return {
      ok: false,
      reason: `unexpected entry function ${fnId ?? "(missing)"}`,
    };
  }

  const firstArg = utx.payload?.arguments?.[0];
  if (typeof firstArg !== "string" || firstArg !== args.expectedBlobName) {
    return {
      ok: false,
      reason: `blobName mismatch: tx has ${String(firstArg)}, expected ${args.expectedBlobName}`,
    };
  }

  return { ok: true };
}

/**
 * Verify that `txHash` is a committed, successful delete_blob call from
 * `expectedSender` for `expectedBlobName`. Same shape as the register
 * verifier — DELETE on /api/posts uses this to make sure the client
 * actually killed the blob on-chain before we drop our cache row.
 *
 *   delete_blob(blobName: vector<u8>)
 *
 * so the first (and only) argument is the blobName string.
 */
export async function verifyDeleteBlobTx(args: {
  txHash: string;
  expectedSender: string;
  expectedBlobName: string;
}): Promise<VerifyResult> {
  const aptos = getAptosServer();
  let tx: Awaited<ReturnType<Aptos["getTransactionByHash"]>>;
  try {
    tx = await aptos.getTransactionByHash({ transactionHash: args.txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `tx lookup failed: ${msg}` };
  }

  if (tx.type !== "user_transaction") {
    return {
      ok: false,
      reason: `tx type is ${tx.type}, expected user_transaction`,
    };
  }

  const utx = tx as unknown as {
    success: boolean;
    sender: string;
    payload?: {
      function?: string;
      arguments?: unknown[];
    };
  };

  if (!utx.success) {
    return { ok: false, reason: "tx not successful on chain" };
  }

  let senderNorm: string;
  let expectedNorm: string;
  try {
    senderNorm = canonical(utx.sender);
    expectedNorm = canonical(args.expectedSender);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `bad address: ${msg}` };
  }
  if (senderNorm !== expectedNorm) {
    return {
      ok: false,
      reason: `tx sender ${senderNorm} != claimed owner ${expectedNorm}`,
    };
  }

  if (utx.payload?.function !== DELETE_BLOB_FN) {
    return {
      ok: false,
      reason: `unexpected entry function ${utx.payload?.function ?? "(missing)"}`,
    };
  }

  const firstArg = utx.payload?.arguments?.[0];
  if (typeof firstArg !== "string" || firstArg !== args.expectedBlobName) {
    return {
      ok: false,
      reason: `blobName mismatch: tx has ${String(firstArg)}, expected ${args.expectedBlobName}`,
    };
  }

  return { ok: true };
}

/**
 * Probe Shelbynet for whether a blob's on-chain metadata resource still
 * exists. Used by the DELETE handler's `force: true` path — when the
 * contract state has been wiped (a devnet upgrade reset module
 * resources), the wallet can no longer submit `delete_blob` because
 * the metadata is gone. In that case we let the owner authoritatively
 * drop the cache row instead, but only after the server itself confirms
 * the blob really is missing (never trusting the client's claim).
 *
 *   { alive: true }   — metadata resource present
 *   { alive: false }  — present in our cache, absent on-chain → ghost
 */
export async function probeBlobMetadata(args: {
  ownerAddress: string;
  blobName: string;
}): Promise<{ alive: boolean }> {
  const aptos = getAptosServer();
  // SDK encodes the blob key as `@<long-addr-without-0x>/<blobName>`.
  const addr = AccountAddress.from(args.ownerAddress, { maxMissingChars: 63 });
  const blobKey = `@${addr.toStringLongWithoutPrefix()}/${args.blobName}`;
  const raw = (await aptos.view({
    payload: {
      function: `${SHELBY_DEPLOYER}::blob_metadata::get_blob_metadata`,
      functionArguments: [blobKey],
    },
  })) as Array<{ vec?: unknown[] }>;
  // get_blob_metadata returns Option<BlobMetadata>: `[{ vec: [data] }]`
  // when present, `[{ vec: [] }]` when absent.
  const alive = !!raw?.[0]?.vec?.[0];
  return { alive };
}

/** Exported for callers that want to canonicalize/compare addresses too. */
export { canonical as canonicalAddress };
