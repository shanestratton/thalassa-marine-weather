import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { supabase } from '../supabase';
import { getLocalSighting, listLocalSightings, updateLocalSighting } from './sightingStore';
import type { LocalSighting, PrivateCatch } from './types';

const TABLE = 'sighting_catches';
const SELECT = 'sighting_id,observer_id,species,length_cm,disposition';
const MAX_ROUND = 50;

export function validatePrivateCatch(
    value: unknown,
): { ok: true; value: PrivateCatch | null } | { ok: false; error: string } {
    if (value === null) return { ok: true, value: null };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { ok: false, error: 'Catch details are invalid.' };
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some((key) => !['species', 'length_cm', 'disposition'].includes(key)))
        return { ok: false, error: 'Catch details are invalid.' };
    if (data.species != null && typeof data.species !== 'string') return { ok: false, error: 'Enter a species name.' };
    const species = typeof data.species === 'string' ? data.species.trim() || null : null;
    if (species && species.length > 120) return { ok: false, error: 'Use at most 120 characters for the species.' };
    let length = data.length_cm == null ? null : data.length_cm;
    if (length !== null) {
        if (typeof length !== 'number' || !Number.isFinite(length))
            return { ok: false, error: 'Enter a length in centimetres.' };
        length = Math.round(length * 10) / 10;
        if (!(length > 0 && length <= 2000))
            return { ok: false, error: 'Length must be greater than zero and at most 2000 cm.' };
    }
    const disposition = data.disposition ?? null;
    if (disposition !== null && disposition !== 'kept' && disposition !== 'released')
        return { ok: false, error: 'Choose kept or released, or leave it unknown.' };
    return {
        ok: true,
        value:
            species === null && length === null && disposition === null
                ? null
                : { species, length_cm: length as number | null, disposition },
    };
}

/** Same owner-scoped durable record and startup outbox as the sighting. */
export async function editPrivateCatch(
    id: string,
    input: unknown,
): Promise<{ record: LocalSighting | null; error: string | null }> {
    const scope = getAuthIdentityScope(),
        checked = validatePrivateCatch(input);
    if (!checked.ok) return { record: null, error: checked.error };
    const saved = await updateLocalSighting(id, scope, (record) => {
        if (record.row.taxon_group !== 'fish' || record.sync.op === 'delete' || record.row.observer_id !== scope.userId)
            return null;
        if (record.privateCatch !== undefined && JSON.stringify(record.privateCatch) === JSON.stringify(checked.value))
            return record;
        const revision = Math.max(Date.now(), (record.privateCatchSync?.revision ?? 0) + 1);
        return {
            ...record,
            privateCatch: checked.value,
            privateCatchSync: { revision, pending: !!scope.userId, attempts: 0, retryAt: null, error: null },
            updatedAtLocal: Math.max(Date.now(), record.updatedAtLocal + 1),
        };
    }).catch(() => null);
    return { record: saved, error: saved ? null : 'This catch is unavailable for this account.' };
}

/** Called only by the existing sightings outbox. A failed sidecar write never
 * marks an ordinary sighting as failed or retries its shared base row. */
export async function drainPrivateCatches(): Promise<{ sent: number; remaining: number }> {
    const scope = getAuthIdentityScope(),
        userId = scope.userId;
    if (!supabase || !userId) return { sent: 0, remaining: 0 };
    const records = (await listLocalSightings(userId)).filter(
        (record) => record.privateCatchSync?.pending && record.sync.op !== 'delete',
    );
    if (!records.length || !isAuthIdentityScopeCurrent(scope)) return { sent: 0, remaining: records.length };
    const session = await supabase.auth.getSession();
    if (!isAuthIdentityScopeCurrent(scope) || session.data.session?.user.id !== userId)
        return { sent: 0, remaining: records.length };
    let sent = 0;
    for (const started of records
        .filter(
            (record) =>
                record.sync.serverKnown &&
                record.row.observer_id === userId &&
                (!record.privateCatchSync?.retryAt || record.privateCatchSync.retryAt <= Date.now()),
        )
        .slice(0, MAX_ROUND)) {
        if (!isAuthIdentityScopeCurrent(scope)) break;
        const checked = validatePrivateCatch(started.privateCatch ?? null);
        let error: unknown = checked.ok ? null : { code: 'invalid' };
        try {
            if (checked.ok && (started.row.taxon_group === 'fish' || checked.value === null)) {
                if (checked.value === null) {
                    ({ error } = await supabase
                        .from(TABLE)
                        .delete()
                        .eq('sighting_id', started.id)
                        .eq('observer_id', userId));
                } else {
                    ({ error } = await supabase
                        .from(TABLE)
                        .insert({ sighting_id: started.id, observer_id: userId, ...checked.value }));
                    if (isAuthIdentityScopeCurrent(scope) && (error as { code?: unknown } | null)?.code === '23505') {
                        // Identity columns have no UPDATE grant. A real INSERT
                        // followed by an owner-filtered mutable PATCH keeps the
                        // DB ownership fence intact, unlike an all-field upsert.
                        const response = await supabase
                            .from(TABLE)
                            .update(checked.value)
                            .eq('sighting_id', started.id)
                            .eq('observer_id', userId)
                            .select('sighting_id');
                        error =
                            response.error ??
                            (Array.isArray(response.data) && !response.data.length ? { code: 'missing' } : null);
                    }
                }
            } else error = { code: 'invalid' };
        } catch {
            error = { code: 'offline' };
        }
        if (!isAuthIdentityScopeCurrent(scope)) break;
        const saved = await updateLocalSighting(started.id, scope, (fresh) => {
            if (fresh.sync.op === 'delete' || fresh.privateCatchSync?.revision !== started.privateCatchSync?.revision)
                return null;
            const attempts = error ? Math.min(10, (fresh.privateCatchSync?.attempts ?? 0) + 1) : 0;
            return {
                ...fresh,
                privateCatchSync: {
                    revision: fresh.privateCatchSync!.revision,
                    pending: !!error,
                    attempts,
                    retryAt: error ? Date.now() + Math.min(30 * 60000, 30000 * 2 ** attempts) : null,
                    error: error
                        ? (error as { code?: unknown }).code === '42P01' ||
                          (error as { code?: unknown }).code === 'PGRST205'
                            ? 'not-available'
                            : 'retry'
                        : null,
                },
            };
        });
        if (saved && !error) sent++;
    }
    return { sent, remaining: records.length - sent };
}

/** A private read is on demand for this actual own fish record. Nothing is
 * joined into crew/public rows, their caches, Realtime events or exports. */
export async function loadPrivateCatch(id: string): Promise<LocalSighting | null> {
    const scope = getAuthIdentityScope(),
        userId = scope.userId;
    const local = await getLocalSighting(id, userId);
    if (
        !isAuthIdentityScopeCurrent(scope) ||
        !local ||
        local.row.taxon_group !== 'fish' ||
        local.row.observer_id !== userId ||
        local.sync.op === 'delete'
    )
        return null;
    if (!supabase || !userId || !local.sync.serverKnown || local.privateCatchSync?.pending) return local;
    const revision = local.privateCatchSync?.revision;
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select(SELECT)
            .eq('sighting_id', id)
            .eq('observer_id', userId)
            .limit(1);
        if (error || !isAuthIdentityScopeCurrent(scope) || !Array.isArray(data))
            return isAuthIdentityScopeCurrent(scope) ? local : null;
        const row = data[0];
        if (row && (row.sighting_id !== id || row.observer_id !== userId)) return local;
        const checked = validatePrivateCatch(
            row
                ? {
                      species: row.species,
                      length_cm: row.length_cm === null ? null : Number(row.length_cm),
                      disposition: row.disposition,
                  }
                : null,
        );
        if (!checked.ok) return local;
        return await updateLocalSighting(id, scope, (fresh) => {
            if (
                fresh.sync.op === 'delete' ||
                fresh.row.taxon_group !== 'fish' ||
                fresh.row.observer_id !== userId ||
                fresh.privateCatchSync?.pending ||
                fresh.privateCatchSync?.revision !== revision
            )
                return null;
            return {
                ...fresh,
                privateCatch: checked.value,
                privateCatchSync: { revision: revision ?? 0, pending: false, attempts: 0, retryAt: null, error: null },
            };
        });
    } catch {
        return isAuthIdentityScopeCurrent(scope) ? local : null;
    }
}
