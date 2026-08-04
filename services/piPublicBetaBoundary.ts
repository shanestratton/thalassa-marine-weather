/**
 * Public-beta security boundary for every Raspberry Pi / boat-LAN surface.
 *
 * The current Pi protocols use unauthenticated plain HTTP for at least some
 * requests. Pairing signatures add useful integrity checks, but they are not
 * an authenticated encrypted transport and must not carry private app data in
 * a public release. Production builds therefore have no Pi escape hatch: the
 * integration is development-only until the replacement transport ships.
 */
export const PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE =
    'Pi integration is unavailable in the public beta while authenticated, encrypted boat-network transport is completed.';

export interface PiBuildPolicyInput {
    dev: boolean;
}

/** Pure policy helper so the release decision has a direct regression test. */
export function resolvePiIntegrationEnabled({ dev }: PiBuildPolicyInput): boolean {
    return dev === true;
}

/**
 * BETA-READINESS: this must remain derived from Vite's build mode only.
 * Do not add a VITE_ production override; every VITE_ value is user-readable
 * and cannot authorize a cleartext LAN transport.
 */
export const PI_INTEGRATION_ENABLED = resolvePiIntegrationEnabled({ dev: import.meta.env.DEV });

/** An invalid protocol ensures an overlooked URL builder fails before I/O. */
export const PI_DISABLED_BASE_URL = 'thalassa-pi-disabled://public-beta';
