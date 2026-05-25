/**
 * Standalone noble + Aztec interop sanity script.
 *
 * Bypasses the adapter pipeline entirely to determine whether noble v3's
 * `signAsync(prehash:false) / verifyAsync(prehash:false)` round-trips, and
 * whether the resulting signature verifies under Aztec's `Ecdsa.verifySignature`.
 *
 * Helps isolate which of these is broken in `demo/src/index.ts`:
 *   (a) noble itself
 *   (b) my adapter pipeline (unpack/normalize/pack)
 *   (c) interop between noble's signature shape and Aztec's verifier
 *   (d) pubkey shape (65B SEC1 vs 64B x||y per codex finding #2)
 */

import { randomBytes } from 'node:crypto';
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import * as secp from '@noble/secp256k1';

async function main() {
  const sk = new Uint8Array(randomBytes(32));
  const msg = new Uint8Array(randomBytes(32)); // the "digest" to be signed directly

  // === noble side ===
  const pkUncompressed = secp.getPublicKey(sk, false); // 65B 0x04 || x || y
  const pkCompressed = secp.getPublicKey(sk, true); //  33B 02/03 || x

  const sigCompact = await secp.signAsync(msg, sk, { prehash: false });
  console.log(`noble signed (${sigCompact.length}B): 0x${Buffer.from(sigCompact).toString('hex')}`);

  const nobleVerify = await secp.verifyAsync(sigCompact, msg, pkUncompressed, {
    prehash: false,
    lowS: true,
  });
  console.log(`noble verify (uncompressed pubkey): ${nobleVerify ? 'OK' : 'FAIL'}`);

  const nobleVerifyCompressed = await secp.verifyAsync(sigCompact, msg, pkCompressed, {
    prehash: false,
    lowS: true,
  });
  console.log(`noble verify (compressed pubkey):   ${nobleVerifyCompressed ? 'OK' : 'FAIL'}`);

  const nobleVerifyLowSFalse = await secp.verifyAsync(sigCompact, msg, pkUncompressed, {
    prehash: false,
    lowS: false,
  });
  console.log(`noble verify (lowS:false):          ${nobleVerifyLowSFalse ? 'OK' : 'FAIL'}`);

  // === Aztec side ===
  // Per codex finding #2 + #7: Aztec wants 64B pubKey (x || y, no prefix), and we must
  // pass the RAW message (not pre-digest) to verifySignature — Aztec internally SHA-256s.
  // So to verify a noble signature on `msg` (where msg was signed directly), we need to
  // pass some `m` such that `sha256(m) == msg`. That's not generally invertible. Trick:
  // construct everything around a known PRE-IMAGE so the digest math works.
  const preimage = new Uint8Array(randomBytes(64)); // arbitrary bytes
  const expectedDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', preimage)); // 32B
  console.log(`\npreimage (${preimage.length}B), expectedDigest (${expectedDigest.length}B)`);

  // Sign the DIGEST directly via noble (mimicking what Trezor does to challenge_hidden).
  const sigOnDigest = await secp.signAsync(expectedDigest, sk, { prehash: false });

  // Verify via Aztec — pass the preimage; Aztec internally SHA-256s → expectedDigest.
  const ecdsa = new Ecdsa();
  const pk64 = Buffer.from(pkUncompressed.slice(1)); // strip 0x04 → 64B x || y
  const r = Buffer.from(sigOnDigest.slice(0, 32));
  const s = Buffer.from(sigOnDigest.slice(32, 64));
  const azSig = new EcdsaSignature(r, s, Buffer.from([0]));
  const aztecVerify = await ecdsa.verifySignature(Buffer.from(preimage), pk64, azSig);
  console.log(
    `Aztec verify (preimage→sha256→digest, 64B x||y pubkey, no v): ${aztecVerify ? 'OK' : 'FAIL'}`,
  );

  // Sanity: also try Aztec.verify on its own sig with its own pk.
  const ownSk = new Uint8Array(randomBytes(32));
  const ownPk = await ecdsa.computePublicKey(Buffer.from(ownSk));
  const ownSig = await ecdsa.constructSignature(Buffer.from(preimage), Buffer.from(ownSk));
  const ownVerify = await ecdsa.verifySignature(Buffer.from(preimage), ownPk, ownSig);
  console.log(`Aztec own sign+verify on preimage:                  ${ownVerify ? 'OK' : 'FAIL'}`);
  console.log(`  ownPk length: ${ownPk.length}B (expecting 64)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
