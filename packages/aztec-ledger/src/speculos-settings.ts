/**
 * Speculos helper: drive the on-device Settings to toggle `blind_signing`.
 *
 * The NVM flag has no read APDU by design (device-only), so tests that need a known
 * state flip it through the Settings UI exactly as a user would. Nav (mapped on
 * nanosp): from the HOME screen — right → "App settings", both → enter (the "Blind
 * signing" switch), both → toggle, then left ×2 back toward home.
 *
 * Caller contract: the device MUST be on the home screen when this is invoked (let
 * any post-APDU status screen auto-dismiss first). One call = one flip.
 */
import type { SpeculosTransport } from './speculos-transport.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Flip the on-device Blind signing switch once (home → settings → toggle → home). */
export async function toggleBlindSigning(transport: SpeculosTransport): Promise<void> {
  await transport.pressButton('right'); // home -> "App settings"
  await sleep(450);
  await transport.pressButton('both'); // enter settings -> "Blind signing"
  await sleep(450);
  await transport.pressButton('both'); // flip the switch (nvm_write)
  await sleep(600);
  await transport.pressButton('left'); // back out of settings
  await sleep(450);
  await transport.pressButton('left'); // -> home
  await sleep(450);
}
