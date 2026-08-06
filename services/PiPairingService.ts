/**
 * Trust-on-first-use pairing with the boat's Pi.
 *
 * Threat model (APP_AUDIT_2026-08-03, boat-LAN data integrity): the app
 * reaches the Pi by mDNS name on whatever Wi-Fi the phone happens to be on.
 * Anyone on a shared marina network can answer `calypso.local` and speak the
 * pi-cache API — including feeding this app wrong depth data. Auto-connecting
 * makes that worse, so auto-connect is gated on the two checks in this file:
 *
 *  1. IDENTITY, at connect time. Pairing pins the Pi's P-256 public key
 *     (SSH-style TOFU: the one human decision is "is this my boat's Pi?"
 *     shown with its name and key fingerprint). Every later connection sends
 *     a fresh random nonce and requires a signature over it. No private key,
 *     no connection — a spoofed hostname alone gets an attacker nothing.
 *
 *  2. INTEGRITY, per payload, for navigation data. The ENC endpoints return
 *     an X-Pi-Signature header: a signature over (body hash | path | time)
 *     with the same pinned key. That closes the on-path tampering gap the
 *     challenge can't (attacker letting the real Pi authenticate, then
 *     modifying responses): a tampered body no longer matches its hash, a
 *     replayed response for a different cell no longer matches its path.
 *
 *  3. CONFIDENTIALITY, per connection (added 2026-08-06). The transport is TLS
 *     terminated by a certificate issued from that same pinned key, verified
 *     natively against the pin — see services/piTls.ts. Before this, the two
 *     checks above meant nobody could FORGE Pi data, but anyone on the Wi-Fi
 *     could read it, including the diary relay token. Pairing is now bound to
 *     the channel: the key on the pairing card must be the key that terminated
 *     the session, so a relay cannot front for the real Pi.
 *
 * What this deliberately does NOT defend: a user who pairs with an attacker's
 * box the very first time (TOFU's inherent limit — the fingerprint on the
 * pairing card is the mitigation, same as SSH), and non-ENC traffic such as
 * weather tiles, which stays unsigned until the Pi signs everything (now
 * encrypted in transit, but still not individually signed).
 *
 * No-downgrade rule: once a host has EVER offered pairing, or the app has
 * paired with anyone, unpaired plain connections to that host are refused —
 * otherwise an attacker just serves 404 on /api/pair/info and slides back
 * into the pre-pairing world.
 */

import { createLogger } from '../utils/createLogger';
import { PI_INTEGRATION_ENABLED, PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from './piPublicBetaBoundary';
import { piPairingFetch, piRequest, type PiTlsResponse } from './piTls';
import { utf8ByteLength } from './enc/types';

const log = createLogger('PiPairing');

const PAIRING_KEY = 'thalassa_pi_pairing_v1';
const SEEN_PAIRABLE_KEY = 'thalassa_pi_seen_pairable_v1';

/** Raw byte length of the challenge nonce (hex-encoded on the wire). */
const NONCE_BYTES = 32;

export interface PiPairingRecord {
    deviceId: string;
    boatName: string;
    /** SPKI DER base64 — the pinned key. */
    publicKeySpki: string;
    /** Human-checkable key digest, as shown at pairing time. */
    fingerprint: string;
    /** Host the pairing was made against (informational — identity is the key, not the host). */
    host: string;
    pairedAt: string;
}

export interface PairInfo {
    deviceId: string;
    boatName: string;
    hostname: string;
    publicKeySpki: string;
    fingerprint: string;
    pairingVersion: number;
}

// ── Pairing store ──────────────────────────────────────────────────

export function getPairing(): PiPairingRecord | null {
    if (!PI_INTEGRATION_ENABLED) return null;
    try {
        const raw = localStorage.getItem(PAIRING_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PiPairingRecord;
        return parsed.deviceId && parsed.publicKeySpki ? parsed : null;
    } catch {
        return null;
    }
}

export function savePairing(record: PiPairingRecord): void {
    if (!PI_INTEGRATION_ENABLED) return;
    localStorage.setItem(PAIRING_KEY, JSON.stringify(record));
    markHostPairable(record.host);
}

export function forgetPairing(): void {
    localStorage.removeItem(PAIRING_KEY);
}

/** Hosts that have ever advertised pairing support — the no-downgrade list. */
function seenPairableHosts(): Set<string> {
    try {
        const raw = localStorage.getItem(SEEN_PAIRABLE_KEY);
        return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
        return new Set();
    }
}

/**
 * True once ANY host has advertised pairing on this device.
 *
 * The zero-config discovery sweep is throttled to 6 h because for most users
 * there is no Pi and sweeping is pure background noise. That reasoning stops
 * applying the moment we know a Pi exists: from then on the skipper is trying
 * to pair, and a 6 h wait to be asked again reads as "the banner never
 * appears" (Shane 2026-08-07).
 */
export function hasEverSeenPairableHost(): boolean {
    if (!PI_INTEGRATION_ENABLED) return false;
    return seenPairableHosts().size > 0;
}

export function markHostPairable(host: string): void {
    try {
        const hosts = seenPairableHosts();
        if (hosts.has(host)) return;
        hosts.add(host);
        localStorage.setItem(SEEN_PAIRABLE_KEY, JSON.stringify([...hosts]));
    } catch {
        /* private mode — the paired record itself still enforces the rule */
    }
}

/**
 * May the app talk plain (unpaired, unverified) to this host? Only in the
 * legacy window: nothing paired yet AND this host has never offered pairing.
 * Exists so an existing user's un-updated Pi keeps working until its next
 * redeploy — and closes as soon as pairing is available, so a spoofer can't
 * force it back open by hiding the pairing endpoints.
 */
export function isLegacyPlainConnectionAllowed(host: string): boolean {
    if (!PI_INTEGRATION_ENABLED) return false;
    return getPairing() === null && !seenPairableHosts().has(host);
}

// ── Crypto ─────────────────────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function randomNonceHex(): string {
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function importPinnedKey(publicKeySpki: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'spki',
        b64ToBytes(publicKeySpki).buffer as ArrayBuffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
    );
}

/** Mirror of the Pi's field concatenation — identity.ts signFields. */
async function verifyFields(publicKeySpki: string, fields: string[], signatureB64: string): Promise<boolean> {
    try {
        const key = await importPinnedKey(publicKeySpki);
        const data = new TextEncoder().encode(fields.join('|'));
        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            b64ToBytes(signatureB64).buffer as ArrayBuffer,
            data,
        );
    } catch (err) {
        log.warn(`signature verification errored: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Flows ──────────────────────────────────────────────────────────

/** Fetch the pairing card contents from a candidate Pi. Null if it has no pairing support. */
export async function fetchPairInfo(baseUrl: string): Promise<PairInfo | null> {
    if (!PI_INTEGRATION_ENABLED) return null;
    try {
        const res = await piPairingFetch(baseUrl);
        if (res.status < 200 || res.status >= 300) return null;
        const data = JSON.parse(res.data) as Partial<PairInfo> & { service?: string };
        if (data?.service !== 'thalassa-pi-cache' || !data.deviceId || !data.publicKeySpki) return null;

        // CHANNEL BINDING. The pairing card advertises a key; `peerSpki` is the
        // key that actually terminated the TLS session. Requiring them to match
        // is what stops a box from relaying a genuine Pi's pairing card while
        // holding the connection itself — it would have to present the real
        // Pi's certificate, which it cannot do without the private key.
        //
        // Empty peerSpki means the browser lane, where script cannot see the
        // peer certificate at all. Refuse to pair there rather than pretend:
        // an unbound pairing would pin a key nobody proved they hold on this
        // connection.
        if (!res.peerSpki) {
            log.warn('refusing to pair without an observable TLS peer key — pair from the app on the boat network');
            return null;
        }
        if (res.peerSpki !== data.publicKeySpki) {
            log.warn('refusing to pair — the pairing card advertises a key that did not terminate the TLS session');
            return null;
        }
        return data as PairInfo;
    } catch {
        return null;
    }
}

/**
 * Challenge a host to prove it holds the pinned private key. This is the
 * gate in front of every auto-connect to a paired Pi.
 */
export async function verifyPairedPi(baseUrl: string, pairing: PiPairingRecord): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED) return false;
    const nonce = randomNonceHex();
    try {
        // Pinned: the transport itself now refuses anything that did not
        // terminate TLS with this key, so a relay cannot even carry the
        // challenge to the real Pi and hand back its answer.
        const res = await piRequest({
            url: `${baseUrl}/api/pair/challenge`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { nonce },
            pinnedSpki: pairing.publicKeySpki,
            connectTimeout: 4000,
            readTimeout: 4000,
            responseType: 'text',
        });
        if (res.status < 200 || res.status >= 300) return false;
        const data = JSON.parse(res.data) as { deviceId?: string; timestamp?: number; signature?: string };
        if (!data?.signature || data.deviceId !== pairing.deviceId) return false;
        return await verifyFields(
            pairing.publicKeySpki,
            ['challenge', nonce, String(data.timestamp), pairing.deviceId],
            data.signature,
        );
    } catch {
        return false;
    }
}

/**
 * Pair with a Pi whose pair-info the user has just approved. Re-fetches the
 * info and immediately challenges it, so the pinned key is provably the one
 * the responder actually holds RIGHT NOW (not just one it displayed).
 */
export async function pairWithPi(baseUrl: string, host: string): Promise<PiPairingRecord | null> {
    if (!PI_INTEGRATION_ENABLED) return null;
    const info = await fetchPairInfo(baseUrl);
    if (!info) return null;

    const candidate: PiPairingRecord = {
        deviceId: info.deviceId,
        boatName: info.boatName,
        publicKeySpki: info.publicKeySpki,
        fingerprint: info.fingerprint,
        host,
        pairedAt: new Date().toISOString(),
    };
    const proven = await verifyPairedPi(baseUrl, candidate);
    if (!proven) {
        log.warn(`pairing aborted — ${host} presented a key it could not sign with`);
        return null;
    }
    savePairing(candidate);
    log.warn(`paired with ${candidate.boatName} (${candidate.deviceId}) at ${host} — fp ${candidate.fingerprint}`);
    return candidate;
}

export interface SignedResponseCheck {
    ok: boolean;
    reason?: string;
}

/**
 * Digest of a routing question — mirror of the Pi's `routeRequestBinding`.
 *
 * POST endpoints all share one path, so the path alone can't distinguish
 * "route from A to B" from "route from C to D": without this an attacker
 * could replay a genuine signed route from an earlier, different voyage.
 * Hash the from/to/draft tuple and bind it into the signed string.
 */
export async function routeRequestBinding(body: Record<string, unknown>): Promise<string> {
    const fields = ['fromLat', 'fromLon', 'toLat', 'toLon', 'draftM'].map((k) =>
        typeof body[k] === 'number' ? String(body[k]) : '',
    );
    return (await sha256Hex(fields.join(','))).slice(0, 32);
}

/**
 * THE way to read anything from the Pi that the app will navigate by.
 *
 * Every safety-critical response goes through here so verification cannot be
 * forgotten at a call site — the review that prompted this found four
 * endpoints (`/route`, `/route-prepped`, `/result/:id`, `/jobs/:id`) plus the
 * on-demand cell pull consuming Pi data with no signature check at all, which
 * let an on-path attacker who merely RELAYS the identity challenge to the real
 * Pi then serve tampered charts and routes.
 *
 * Fetches as text and verifies before parsing, so the bytes hashed are exactly
 * the bytes signed. When unpaired (legacy grace window) it parses unverified,
 * matching pre-pairing behaviour.
 */
/**
 * A pinned request to the Pi, WITHOUT the per-payload signature check.
 *
 * For endpoints the Pi does not sign — /health, /api/admin/status,
 * /api/configure, /cache/purge, tiles, OSM overlays, wind grids. Use
 * fetchVerifiedFromPi instead for anything the app will navigate by.
 *
 * This exists because switching the Pi to TLS moved the goalposts for EVERY
 * caller at once (2026-08-07). `piCache.baseUrl` became https, and the Pi's
 * certificate is self-signed and pinned — so any call still going out through
 * CapacitorHttp or plain fetch now fails the handshake instead of returning
 * data. That silently killed checkHealth, which is the gate isAvailable()
 * depends on, which is the gate the ENC sync depends on: the Pi could never
 * become reachable, so nothing synced and the app reported no charts.
 *
 * Routing every caller through here is what makes the TLS switch complete.
 */
export async function pinnedPiRequest(options: {
    url: string;
    method?: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: 'text' | 'arraybuffer';
}): Promise<PiTlsResponse> {
    if (!PI_INTEGRATION_ENABLED) throw new Error(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE);
    return piRequest({ ...options, pinnedSpki: getPairing()?.publicKeySpki });
}

export async function fetchVerifiedFromPi<T>(options: {
    url: string;
    method?: 'GET' | 'POST';
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    /** Extra binding for POSTs — see routeRequestBinding. */
    requestBinding?: string;
    /** Reject oversized navigation payloads before hashing/JSON.parse. The
     * native bridge has already received the response, but this still avoids
     * turning an accidental/hostile body into multiple further heap copies. */
    maxResponseBytes?: number;
}): Promise<T> {
    if (!PI_INTEGRATION_ENABLED) throw new Error(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE);
    const {
        url,
        method = 'GET',
        data,
        connectTimeout = 5000,
        readTimeout = 30000,
        requestBinding,
        maxResponseBytes,
    } = options;

    // Pinned transport, always. There is no unpinned lane to fall back to:
    // this function exists so navigation data cannot be read from anything
    // that is not the paired Pi, and an unverified channel would undo that
    // before the signature check ever ran.
    const res = await piRequest({
        url,
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        data: method === 'POST' ? data : undefined,
        pinnedSpki: getPairing()?.publicKeySpki,
        connectTimeout,
        readTimeout,
        responseType: 'text',
    });

    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (maxResponseBytes !== undefined) {
        if (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('Invalid response size limit');
        if (body.length > maxResponseBytes || utf8ByteLength(body, maxResponseBytes) > maxResponseBytes) {
            throw new Error(`Pi response exceeds the ${(maxResponseBytes / 1_048_576).toFixed(0)} MB safety limit`);
        }
    }

    const pairing = getPairing();
    if (pairing) {
        const rawPath = new URL(url).pathname;
        const path = requestBinding ? `${rawPath}#${requestBinding}` : rawPath;
        const check = await verifySignedResponse(
            pairing,
            body,
            path,
            (res.headers ?? {}) as Record<string, string | undefined>,
        );
        if (!check.ok) {
            throw new Error(`Pi response for ${rawPath} failed signature check (${check.reason}) — refusing the data`);
        }
    }
    return JSON.parse(body) as T;
}

/**
 * Verify a signed response from a paired Pi against the pinned key.
 *
 * `body` must be the exact text received; `path` the pathname the app
 * requested (query excluded). The timestamp rides inside the signature but
 * freshness is only logged — boat Pi clocks drift, and the hash+path binding
 * is what carries the integrity guarantee.
 */
export async function verifySignedResponse(
    pairing: PiPairingRecord,
    body: string,
    path: string,
    headers: Record<string, string | undefined>,
): Promise<SignedResponseCheck> {
    // Header lookup case-insensitively — Capacitor lowercases on some platforms.
    const header = (name: string): string | undefined =>
        headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];

    const signature = header('X-Pi-Signature');
    const time = header('X-Pi-Signature-Time');
    if (!signature || !time) return { ok: false, reason: 'response is not signed' };

    const bodyHash = await sha256Hex(body);
    const valid = await verifyFields(pairing.publicKeySpki, ['payload', bodyHash, path, time], signature);
    if (!valid) return { ok: false, reason: 'signature does not verify against the paired key' };

    const skewMs = Math.abs(Date.now() - Number(time));
    if (Number.isFinite(skewMs) && skewMs > 7 * 24 * 3600 * 1000) {
        log.warn(`signed response for ${path} has ${Math.round(skewMs / 3600000)}h clock skew — check the Pi's clock`);
    }
    return { ok: true };
}
