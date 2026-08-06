/**
 * Release boundary for every Raspberry Pi / boat-LAN surface.
 *
 * HISTORY — why this file used to say "development only"
 * ─────────────────────────────────────────────────────
 * The Pi protocols carried app data over unauthenticated plain HTTP. Pairing
 * signatures added real integrity checks, but integrity is not
 * confidentiality: anyone on the marina Wi-Fi could READ the traffic, and
 * DiaryRelayTransport hands a relay token across it. That is not something to
 * ship, so production builds had no Pi escape hatch at all.
 *
 * WHAT CHANGED — 2026-08-06
 * ─────────────────────────
 * The transport is now TLS, terminated by the Pi with a certificate issued
 * from the very key the app already pinned at pairing
 * (pi-cache/src/tlsIdentity.ts), and validated natively by comparing the
 * leaf's SubjectPublicKeyInfo to that pin (ios/App/App/PiTlsPlugin.swift).
 * Authenticated and encrypted, offline, with no CA and no expiry cliff — the
 * replacement transport this file was waiting for.
 *
 * THE RULE THAT REPLACES "dev only"
 * ─────────────────────────────────
 * Pi access requires the pinning transport to be PRESENT, not merely
 * requested. That is a capability check, not a flag: `Capacitor.isPluginAvailable`
 * answers whether this build actually contains the native verifier. A web
 * build, an old shell, or a stripped binary therefore has no Pi at all, rather
 * than a Pi it cannot verify.
 *
 * The old warning still stands and is the reason the check has this shape:
 * do NOT reintroduce a VITE_ override. Every VITE_ value is user-readable and
 * user-settable, and no build-time string can authorize an unverified
 * transport. Presence of the verifier is the only thing that may open this.
 */

import { isPinnedTransportAvailable } from './piTls';

export const PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE =
    'Pi integration needs the pinned boat-network transport, which this build does not include.';

export interface PiBuildPolicyInput {
    /** Vite dev build — the Mac talks to the Pi over the dev server's lane. */
    dev: boolean;
    /** Is the native certificate-pinning verifier present in THIS build? */
    pinnedTransport: boolean;
}

/**
 * Pure policy helper so the release decision has a direct regression test.
 *
 * Dev keeps its lane because a developer on the same LAN, with the Pi's
 * certificate trusted in their browser, is a deliberate and supervised
 * situation. Everything else must have the verifier.
 */
export function resolvePiIntegrationEnabled({ dev, pinnedTransport }: PiBuildPolicyInput): boolean {
    return pinnedTransport === true || dev === true;
}

export const PI_INTEGRATION_ENABLED = resolvePiIntegrationEnabled({
    dev: import.meta.env.DEV,
    pinnedTransport: isPinnedTransportAvailable(),
});

/** An invalid protocol ensures an overlooked URL builder fails before I/O. */
export const PI_DISABLED_BASE_URL = 'thalassa-pi-disabled://unavailable';
