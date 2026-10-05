/**
 * Which boat a seabed batch belongs to, proved rather than taken on trust.
 *
 * Only the OWNER's platform logs (crew never do), and a boat that has been
 * released or sold is archived, so every request re-checks
 * boats.owner_id = caller AND archived_at IS NULL. A new owner of the hull
 * gets a new platform row and a new anonymous id; the old owner's Pi cannot
 * keep feeding the old one.
 */

/** supabase-js builders are thenables, not Promises; typed loosely on purpose (see pi-relay-auth.ts). */
export interface QueryClient {
    // deno-lint-ignore no-explicit-any
    from(table: string): any;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Lookup<T> = { ok: true; value: T } | { ok: false };

function stringField(data: unknown, key: string): string | null {
    const v = (data as Record<string, unknown> | null)?.[key];
    return typeof v === 'string' ? v : null;
}

/** The boat id when the caller owns it and it is still active; null when not; !ok when the lookup failed. */
export async function ownedActiveBoat(
    admin: QueryClient,
    ownerId: string,
    boatId: unknown,
): Promise<Lookup<string | null>> {
    if (typeof boatId !== 'string' || !UUID_RE.test(boatId)) return { ok: true, value: null };
    const { data, error } = await admin
        .from('boats')
        .select('id')
        .eq('id', boatId)
        .eq('owner_id', ownerId)
        .is('archived_at', null)
        .maybeSingle();
    if (error) return { ok: false };
    return { ok: true, value: stringField(data, 'id') };
}

/**
 * The hull a Pi is bolted to: the boat stamped on its pairing
 * (pi_diary_relays.boat_id, since 2026-09-08), else the owner's active vessel
 * (read exactly as telemetry-relay reads it). Either way it must pass the
 * ownership proof above.
 */
export async function piBoat(admin: QueryClient, ownerId: string, relayId: string): Promise<Lookup<string | null>> {
    const relay = await admin.from('pi_diary_relays').select('boat_id').eq('relay_id', relayId).maybeSingle();
    if (relay.error) return { ok: false };
    let candidate = stringField(relay.data, 'boat_id');
    if (!candidate) {
        const active = await admin.from('user_active_vessels').select('boat_id').eq('user_id', ownerId).maybeSingle();
        if (active.error) return { ok: false };
        candidate = stringField(active.data, 'boat_id');
    }
    return candidate ? ownedActiveBoat(admin, ownerId, candidate) : { ok: true, value: null };
}

export interface PlatformRow {
    id: string;
    csb_uuid: string;
    enabled: boolean;
    consent_version: string | null;
    capture_device_id: string | null;
    /** When the logger last changed (set by a trigger, never by a client). */
    capture_changed_at: string | null;
    privacy_zones: unknown;
    sounder_note: string | null;
    vessel: unknown;
    updated_at: string;
}

export async function loadPlatform(
    admin: QueryClient,
    ownerId: string,
    boatId: string,
): Promise<Lookup<PlatformRow | null>> {
    const { data, error } = await admin
        .from('seabed_platforms')
        .select(
            'id, csb_uuid, enabled, consent_version, capture_device_id, capture_changed_at, privacy_zones, sounder_note, vessel, updated_at',
        )
        .eq('owner_id', ownerId)
        .eq('boat_id', boatId)
        .maybeSingle();
    if (error) return { ok: false };
    const row = data as PlatformRow | null;
    if (!row) return { ok: true, value: null };
    if (typeof row.id !== 'string' || typeof row.csb_uuid !== 'string' || typeof row.enabled !== 'boolean') {
        return { ok: false };
    }
    return { ok: true, value: row };
}
