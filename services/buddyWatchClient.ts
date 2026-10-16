import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import {
    parseBuddyConfiguration,
    parseBuddyState,
    type BuddyConfiguration,
    type BuddyState,
} from '../utils/buddyWatch';
export interface BuddyWatchRow {
    id: string;
    revision: string;
    configuration: BuddyConfiguration;
    state: BuddyState | null;
}
export interface BuddyWatchList {
    schema: 1;
    ownerId: string;
    boatId: string;
    ready: boolean;
    checkedAt: number;
    watches: BuddyWatchRow[];
}
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
export function parseBuddyWatchList(
    value: unknown,
    boatId: string,
    scope: AuthIdentityScope,
    now = Date.now(),
): BuddyWatchList | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
        v.schema !== 1 ||
        v.ownerId !== scope.userId ||
        v.boatId !== boatId ||
        typeof v.ready !== 'boolean' ||
        typeof v.checkedAt !== 'number' ||
        !Number.isSafeInteger(v.checkedAt) ||
        v.checkedAt > now + 1000 ||
        now - v.checkedAt > 60000 ||
        !Array.isArray(v.watches) ||
        v.watches.length > 10 ||
        Object.keys(v).some((k) => !['schema', 'ownerId', 'boatId', 'ready', 'checkedAt', 'watches'].includes(k))
    )
        return null;
    const ids = new Set(),
        identities = new Set();
    for (const r of v.watches) {
        if (
            !r ||
            typeof r !== 'object' ||
            !uuid(r.id) ||
            !uuid(r.revision) ||
            Object.keys(r).some((k) => !['id', 'revision', 'configuration', 'state'].includes(k)) ||
            !parseBuddyConfiguration(r.configuration) ||
            (r.state !== null && !parseBuddyState(r.state)) ||
            ids.has(r.id) ||
            identities.has(r.configuration.mmsi)
        )
            return null;
        const state = r.state === null ? null : parseBuddyState(r.state);
        if (state?.observedAt != null && state.observedAt > v.checkedAt) return null;
        ids.add(r.id);
        identities.add(r.configuration.mmsi);
    }
    return v as unknown as BuddyWatchList;
}
export async function listBuddyWatches(boatId: string, scope = getAuthIdentityScope()): Promise<BuddyWatchList | null> {
    if (!supabase || !scope.userId || !uuid(boatId) || !isAuthIdentityScopeCurrent(scope) || satelliteModeActive())
        return null;
    try {
        const reply = await withTimeout(
            Promise.resolve(supabase.rpc('buddy_watch_list', { p_boat_id: boatId })),
            null,
            5000,
        );
        return reply && !reply.error && isAuthIdentityScopeCurrent(scope) && !satelliteModeActive()
            ? parseBuddyWatchList(reply.data, boatId, scope)
            : null;
    } catch {
        return null;
    }
}
export async function saveBuddyWatch(
    boatId: string,
    row: Pick<BuddyWatchRow, 'id' | 'revision'> | null,
    configuration: BuddyConfiguration | null,
    scope: AuthIdentityScope,
): Promise<void> {
    if (
        !supabase ||
        !scope.userId ||
        !uuid(boatId) ||
        !isAuthIdentityScopeCurrent(scope) ||
        satelliteModeActive() ||
        (row && (!uuid(row.id) || !uuid(row.revision))) ||
        (configuration !== null && !parseBuddyConfiguration(configuration)) ||
        (!row && configuration === null)
    )
        throw new Error('Connect with the current owner to review this watch.');
    const reply = await withTimeout(
        Promise.resolve(
            supabase.rpc('configure_buddy_watch', {
                p_boat_id: boatId,
                p_watch_id: row?.id ?? null,
                p_expected: row?.revision ?? null,
                p_configuration: configuration,
            }),
        ),
        null,
        5000,
    );
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed.');
    if (reply?.error?.code === '40001')
        throw new Error('Changed on another phone. Reload and review; nothing was retried.');
    if (reply?.error?.code === '55000')
        throw new Error('Buddy notices are held pending source and delivery readiness.');
    if (reply?.error?.code === '54000')
        throw new Error('Up to ten buddy boats per account. Remove another follow first.');
    if (reply?.error?.code === '23505')
        throw new Error('This AIS identity is already followed on one of your vessels.');
    if (!reply || reply.error || !uuid(reply.data)) throw new Error('Watch not confirmed. Reload before retrying.');
}
