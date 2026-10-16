import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import { shoreRecord, shoreUuid } from '../utils/shoreContacts';
import {
    parseOverdueConfiguration,
    parseOverdueState,
    type OverdueConfiguration,
    type OverdueState,
} from '../utils/overdueWatch';
export interface OverdueStatus {
    schema: 1;
    ownerId: string;
    boatId: string;
    checkedAt: number;
    ready: boolean;
    watch: {
        revision: string;
        configuration: OverdueConfiguration;
        state: OverdueState;
        endReason: 'arrived' | 'cancelled' | null;
        reviewRequired: boolean;
    } | null;
}
const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export function parseOverdueStatus(
    v: unknown,
    boat: string,
    scope: AuthIdentityScope,
    now = Date.now(),
): OverdueStatus | null {
    if (
        !shoreRecord(v) ||
        !exact(v, ['schema', 'ownerId', 'boatId', 'checkedAt', 'ready', 'watch']) ||
        v.schema !== 1 ||
        v.ownerId !== scope.userId ||
        v.boatId !== boat ||
        typeof v.ready !== 'boolean' ||
        typeof v.checkedAt !== 'number' ||
        !Number.isSafeInteger(v.checkedAt) ||
        v.checkedAt <= 0 ||
        v.checkedAt > now ||
        now - v.checkedAt > 60000
    )
        return null;
    if (v.watch !== null) {
        const w = v.watch;
        if (
            !shoreRecord(w) ||
            !exact(w, ['revision', 'configuration', 'state', 'endReason', 'reviewRequired']) ||
            typeof w.reviewRequired !== 'boolean' ||
            !shoreUuid(w.revision) ||
            !parseOverdueConfiguration(w.configuration) ||
            !parseOverdueState(w.state) ||
            (w.endReason !== null && !['arrived', 'cancelled'].includes(String(w.endReason)))
        )
            return null;
        const state = w.state as unknown as OverdueState,
            checkedAt = v.checkedAt;
        if (
            Object.values(state).some((x) => x !== null && x > checkedAt) ||
            (state.endedAt === null) !== (w.endReason === null) ||
            (state.endedAt !== null && (w.configuration as unknown as OverdueConfiguration).enabled)
        )
            return null;
    }
    return v as unknown as OverdueStatus;
}
const current = (boat: string, scope: AuthIdentityScope) =>
    !!supabase && !!scope.userId && shoreUuid(boat) && isAuthIdentityScopeCurrent(scope) && !satelliteModeActive();
export async function loadOverdueStatus(boat: string, scope = getAuthIdentityScope()): Promise<OverdueStatus | null> {
    if (!current(boat, scope)) return null;
    try {
        const r = await withTimeout(
            Promise.resolve(supabase!.rpc('overdue_watch_status', { p_boat_id: boat })),
            null,
            5000,
        );
        return current(boat, scope) && r && !r.error ? parseOverdueStatus(r.data, boat, scope) : null;
    } catch {
        return null;
    }
}
async function mutate(
    boat: string,
    scope: AuthIdentityScope,
    name: 'configure_overdue_watch' | 'end_overdue_watch',
    args: Record<string, unknown>,
): Promise<void> {
    if (!current(boat, scope)) throw new Error('Review this owned vessel online.');
    const r = await withTimeout(Promise.resolve(supabase!.rpc(name, { p_boat_id: boat, ...args })), null, 5000);
    if (!current(boat, scope)) throw new Error('Account or network policy changed.');
    if (r?.error?.code === '40001')
        throw new Error('Changed on another phone. Reload and review; nothing was retried.');
    if (!r || r.error || !shoreUuid(r.data))
        throw new Error('Plan, consent, device or delivery capability unavailable.');
}
export async function saveOverdueWatch(
    boat: string,
    expected: string | null,
    configuration: OverdueConfiguration,
    scope: AuthIdentityScope,
): Promise<void> {
    if (
        (expected !== null && !shoreUuid(expected)) ||
        !parseOverdueConfiguration(configuration, Date.now(), configuration.enabled)
    )
        throw new Error('Review a valid future compact plan and explicit contacts.');
    await mutate(boat, scope, 'configure_overdue_watch', { p_expected: expected, p_configuration: configuration });
}
export async function endOverdueWatch(
    boat: string,
    expected: string,
    reason: 'arrived' | 'cancelled',
    scope: AuthIdentityScope,
): Promise<void> {
    if (!shoreUuid(expected) || !['arrived', 'cancelled'].includes(reason))
        throw new Error('Explicit current watch action required.');
    await mutate(boat, scope, 'end_overdue_watch', { p_expected: expected, p_reason: reason });
}
