import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import { parseWeatherPositionStatus, type WeatherPositionStatus } from '../utils/weatherPosition';
import {
    parseWeatherWatchPreferences,
    type WeatherWatchCapability,
    type WeatherWatchFeature,
    type WeatherWatchPreferences,
} from '../utils/weatherWatch';
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export interface WeatherWatchStatus {
    profile: { revision: string; preferences: WeatherWatchPreferences } | null;
    capabilities: Record<WeatherWatchFeature, WeatherWatchCapability>;
    position: WeatherPositionStatus;
}
export function parseWeatherWatchStatus(value: unknown, now: number): WeatherWatchStatus | null {
    if (!object(value) || value.schema !== 1 || !object(value.capabilities)) return null;
    const capabilities = {} as WeatherWatchStatus['capabilities'];
    for (const feature of ['morning', 'rain', 'storm', 'gust'] as const) {
        const cap = value.capabilities[feature];
        if (
            !object(cap) ||
            !Number.isInteger(cap.functionVersion) ||
            !Number.isInteger(cap.deliveryVersion) ||
            typeof cap.scheduled !== 'boolean' ||
            ![cap.entitlementUntil, cap.succeededAt].every(
                (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
            )
        )
            return null;
        capabilities[feature] = cap as unknown as WeatherWatchCapability;
    }
    const position =
        value.position === undefined
            ? { registration: null, position: null }
            : parseWeatherPositionStatus(value.position, now);
    if (!position) return null;
    if (value.profile === null) return { profile: null, capabilities, position };
    if (!object(value.profile) || !uuid(value.profile.revision)) return null;
    const preferences = parseWeatherWatchPreferences(value.profile.preferences, now);
    return preferences ? { profile: { revision: value.profile.revision, preferences }, capabilities, position } : null;
}
export async function fetchWeatherWatchStatus(
    boatId: string,
    scope = getAuthIdentityScope(),
): Promise<WeatherWatchStatus | null> {
    if (!uuid(boatId) || !scope.userId || !supabase || !isAuthIdentityScopeCurrent(scope) || satelliteModeActive())
        return null;
    try {
        const result = await withTimeout(
            Promise.resolve(supabase.rpc('weather_watch_status', { p_boat_id: boatId })),
            null,
            5000,
        );
        return isAuthIdentityScopeCurrent(scope) && result && !result.error
            ? parseWeatherWatchStatus(result.data, Date.now())
            : null;
    } catch {
        return null;
    }
}
/** CAS only; a conflict must be read/reviewed. No offline queue, silent retry or automatic opt-in. */
export async function saveWeatherWatch(
    boatId: string,
    revision: string | null,
    preferences: WeatherWatchPreferences,
    scope: AuthIdentityScope,
): Promise<string> {
    if (
        !uuid(boatId) ||
        !scope.userId ||
        !supabase ||
        !isAuthIdentityScopeCurrent(scope) ||
        satelliteModeActive() ||
        (revision !== null && !uuid(revision)) ||
        !parseWeatherWatchPreferences(preferences, Date.now())
    )
        throw new Error('Weather watch unavailable');
    const result = await withTimeout(
        Promise.resolve(
            supabase.rpc('configure_weather_watch', {
                p_boat_id: boatId,
                p_expected: revision,
                p_preferences: preferences,
            }),
        ),
        null,
        5000,
    );
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed');
    if (result?.error?.code === '40001')
        throw new Error('Configuration changed on another device. Reload and review it.');
    if (!result || result.error || !object(result.data) || !uuid(result.data.revision))
        throw new Error('Save not confirmed. Reload before retrying.');
    return result.data.revision;
}
