/**
 * pi-relay-auth — the boat Pi's identity, shared by every relay function.
 *
 * A signed-in device pairs a Pi once through diary-relay, which hands the Pi a
 * random bearer and keeps only its SHA-256 in `pi_diary_relays`. Every Pi →
 * cloud request since carries `X-Thalassa-Pi-Relay-Id` and
 * `X-Thalassa-Pi-Relay-Token`; this module turns those into the owning
 * skipper's user id, or a 401. The Pi never holds a service-role key.
 */
export const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface PiRelayIdentity {
    ownerId: string;
    relayId: string;
}

/**
 * The two calls this module makes, typed loosely on purpose: supabase-js
 * returns thenable builders, not Promises, and mirroring its generics here
 * sent the type checker into an infinite instantiation. A structural PromiseLike
 * is all `await` needs.
 */
export interface RelayLookupClient {
    // deno-lint-ignore no-explicit-any
    from(table: string): any;
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality for same-length hex digests. */
export function secureEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * Read the relay credential from the headers (diary-relay style) or, failing
 * that, from `relay_id` / `token` in the body (anchor-relay style), so either
 * Pi client convention works.
 */
export function readRelayCredential(
    req: Request,
    body: Record<string, unknown> | null,
): { relayId: string; token: string } | null {
    const headerId = req.headers.get('x-thalassa-pi-relay-id')?.trim() ?? '';
    const headerToken = req.headers.get('x-thalassa-pi-relay-token')?.trim().toLowerCase() ?? '';
    if (headerId || headerToken) return { relayId: headerId, token: headerToken };
    const bodyId = typeof body?.relay_id === 'string' ? body.relay_id.trim() : '';
    const bodyToken = typeof body?.token === 'string' ? body.token.trim().toLowerCase() : '';
    if (bodyId || bodyToken) return { relayId: bodyId, token: bodyToken };
    return null;
}

export type RelayAuthFailure = { status: 401 | 503; error: string };

/** Resolve a relay credential to its owner, or say precisely why not. */
export async function authenticatePiRelay(
    admin: RelayLookupClient,
    credential: { relayId: string; token: string } | null,
    log: (message: string) => void = console.error,
): Promise<PiRelayIdentity | RelayAuthFailure> {
    if (!credential || !RELAY_ID_RE.test(credential.relayId) || !TOKEN_RE.test(credential.token)) {
        return { status: 401, error: 'Invalid relay credentials' };
    }
    const { data, error } = await admin
        .from('pi_diary_relays')
        .select('owner_id, token_hash, enabled')
        .eq('relay_id', credential.relayId)
        .maybeSingle();
    if (error) {
        log(`[pi-relay-auth] relay lookup failed: ${error.message}`);
        return { status: 503, error: 'Relay lookup unavailable' };
    }
    const row = data as { owner_id?: unknown; token_hash?: unknown; enabled?: unknown } | null;
    if (!row || typeof row.owner_id !== 'string' || typeof row.token_hash !== 'string') {
        return { status: 401, error: 'Relay not recognised' };
    }
    if (row.enabled !== true || !secureEqual(await sha256Hex(credential.token), row.token_hash)) {
        return { status: 401, error: 'Relay not authorised' };
    }
    return { ownerId: row.owner_id, relayId: credential.relayId };
}

/** Best-effort heartbeat; never lets a bookkeeping failure fail the request. */
export function touchPiRelay(admin: RelayLookupClient, relayId: string): void {
    try {
        void admin.from('pi_diary_relays').update({ last_seen_at: new Date().toISOString() }).eq('relay_id', relayId);
    } catch {
        /* heartbeat only */
    }
}
