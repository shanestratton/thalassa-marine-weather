import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import { weatherPositionUuid } from '../utils/weatherPosition';
export interface LightningWatchStatus {
    profile: { revision: string; enabled: boolean } | null;
    ready: boolean;
    positionFresh: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
export function parseLightningWatchStatus(value: unknown): LightningWatchStatus | null {
    if (
        !object(value) ||
        value.schema !== 1 ||
        typeof value.ready !== 'boolean' ||
        typeof value.positionFresh !== 'boolean'
    )
        return null;
    const profile = value.profile;
    if (
        profile !== null &&
        (!object(profile) || !weatherPositionUuid(profile.revision) || typeof profile.enabled !== 'boolean')
    )
        return null;
    return {
        profile: profile as LightningWatchStatus['profile'],
        ready: value.ready,
        positionFresh: value.positionFresh,
    };
}
export async function fetchLightningWatchStatus(
    boatId: string,
    scope = getAuthIdentityScope(),
): Promise<LightningWatchStatus | null> {
    if (
        !weatherPositionUuid(boatId) ||
        !scope.userId ||
        !supabase ||
        !isAuthIdentityScopeCurrent(scope) ||
        satelliteModeActive()
    )
        return null;
    try {
        const result = await withTimeout(
            Promise.resolve(supabase.rpc('lightning_watch_status', { p_boat_id: boatId })),
            null,
            5000,
        );
        return isAuthIdentityScopeCurrent(scope) && result && !result.error
            ? parseLightningWatchStatus(result.data)
            : null;
    } catch {
        return null;
    }
}
/** One explicit online CAS. No offline queue, automatic retry or inferred consent. */
export async function saveLightningWatch(
    boatId: string,
    revision: string | null,
    enabled: boolean,
    scope: AuthIdentityScope,
): Promise<void> {
    if (
        !weatherPositionUuid(boatId) ||
        (revision !== null && !weatherPositionUuid(revision)) ||
        typeof enabled !== 'boolean' ||
        !scope.userId ||
        !supabase ||
        !isAuthIdentityScopeCurrent(scope) ||
        satelliteModeActive()
    )
        throw Error('Lightning watch unavailable.');
    const result = await withTimeout(
        Promise.resolve(
            supabase.rpc('configure_lightning_watch', { p_boat_id: boatId, p_expected: revision, p_enabled: enabled }),
        ),
        null,
        5000,
    );
    if (!isAuthIdentityScopeCurrent(scope)) throw Error('Account changed.');
    if (result?.error?.code === '40001') throw Error('Watch changed on another device. Reload and review it.');
    if (
        !result ||
        result.error ||
        !object(result.data) ||
        !weatherPositionUuid(result.data.revision) ||
        result.data.enabled !== enabled
    )
        throw Error('Change not confirmed. Reload before retrying.');
}
