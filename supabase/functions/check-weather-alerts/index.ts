/**
 * check-weather-alerts — Server-Side Weather Alert Cron
 *
 * Runs every 30 minutes via pg_cron → pg_net HTTP POST.
 * For each user with ≥1 alert threshold enabled:
 *   1. Read their location (defaultLocation or Guardian last_known)
 *   2. Fetch current weather from Open-Meteo
 *   3. Evaluate thresholds from user_settings.settings.notifications
 *   4. Dedup against weather_alerts_log (skip if alerted in last 6h)
 *   5. Insert into push_notification_queue → triggers send-push webhook
 *
 * This ensures alerts fire even when the app is backgrounded/closed.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    fetchWithTimeout,
    jsonResponse,
    readResponseJsonObjectLimited,
    requireServiceRolePost,
} from '../_shared/http-security.ts';

// ── Open-Meteo weather variables we need ──
const WEATHER_VARS = [
    'weather_code',
    'temperature_2m',
    'wind_speed_10m',
    'wind_gusts_10m',
    'visibility',
    'uv_index',
].join(',');
const WEATHER_KEYS = [
    'weather_code',
    'temperature_2m',
    'wind_speed_10m',
    'wind_gusts_10m',
    'visibility',
    'uv_index',
] as const;
const MAX_WEATHER_RESPONSE_BYTES = 128_000;

// ── Alert type configurations ──
interface AlertCheck {
    type: string;
    setting: string;
    getValue: (weather: Record<string, number | null>) => number | null;
    compare: 'gte' | 'lte'; // gte = fire when value >= threshold, lte = fire when value <= threshold
    formatValue: (v: number) => string;
    emoji: string;
    label: string;
    unit: string;
}

const ALERT_CHECKS: AlertCheck[] = [
    {
        type: 'wind',
        setting: 'wind',
        getValue: (w) => (w.wind_speed_10m != null ? kphToKts(w.wind_speed_10m) : null),
        compare: 'gte',
        formatValue: (v) => `${Math.round(v)}`,
        emoji: '🌬️',
        label: 'High Wind',
        unit: 'kts',
    },
    {
        type: 'gusts',
        setting: 'gusts',
        getValue: (w) => (w.wind_gusts_10m != null ? kphToKts(w.wind_gusts_10m) : null),
        compare: 'gte',
        formatValue: (v) => `${Math.round(v)}`,
        emoji: '💨',
        label: 'Gust Alert',
        unit: 'kts',
    },
    {
        type: 'visibility',
        setting: 'visibility',
        getValue: (w) => (w.visibility != null ? w.visibility / 1852 : null), // metres → NM
        compare: 'lte',
        formatValue: (v) => v.toFixed(1),
        emoji: '🌫️',
        label: 'Low Visibility',
        unit: 'NM',
    },
    {
        type: 'uv',
        setting: 'uv',
        getValue: (w) => w.uv_index,
        compare: 'gte',
        formatValue: (v) => `${Math.round(v)}`,
        emoji: '☀️',
        label: 'High UV',
        unit: 'idx',
    },
    {
        type: 'tempHigh',
        setting: 'tempHigh',
        getValue: (w) => w.temperature_2m,
        compare: 'gte',
        formatValue: (v) => `${Math.round(v)}°C`,
        emoji: '🌡️',
        label: 'Heat Alert',
        unit: '',
    },
    {
        type: 'tempLow',
        setting: 'tempLow',
        getValue: (w) => w.temperature_2m,
        compare: 'lte',
        formatValue: (v) => `${Math.round(v)}°C`,
        emoji: '🥶',
        label: 'Freeze Alert',
        unit: '',
    },
    {
        type: 'precipitation',
        setting: 'precipitation',
        getValue: (w) => {
            // Weather codes 51-99 indicate precipitation/storm
            const code = w.weather_code;
            if (code == null) return null;
            return code >= 51 ? 1 : 0;
        },
        compare: 'gte',
        formatValue: () => '',
        emoji: '🌧️',
        label: 'Precipitation',
        unit: '',
    },
];

function kphToKts(kph: number): number {
    return kph * 0.539957;
}

// ── Weather code to description ──
function weatherCodeToDescription(code: number): string {
    if (code <= 3) return 'Clear/Cloudy';
    if (code <= 48) return 'Fog';
    if (code <= 55) return 'Drizzle';
    if (code <= 57) return 'Freezing Drizzle';
    if (code <= 65) return 'Rain';
    if (code <= 67) return 'Freezing Rain';
    if (code <= 77) return 'Snow';
    if (code <= 82) return 'Rain Showers';
    if (code <= 86) return 'Snow Showers';
    if (code === 95) return 'Thunderstorm';
    if (code <= 99) return 'Thunderstorm with Hail';
    return 'Unknown';
}

function parseWeatherCurrent(value: Record<string, unknown>): Record<string, number | null> | null {
    const current = value.current;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;

    const result: Record<string, number | null> = {};
    for (const key of WEATHER_KEYS) {
        const field = (current as Record<string, unknown>)[key];
        if (field === null) {
            result[key] = null;
        } else if (typeof field === 'number' && Number.isFinite(field)) {
            result[key] = field;
        } else {
            return null;
        }
    }
    return result;
}

// ── Batch weather fetch from Open-Meteo ──
// Groups nearby locations to minimize API calls
async function fetchWeather(lat: number, lon: number): Promise<Record<string, number | null> | null> {
    try {
        // Use commercial API — free tier is not licensed for App Store apps
        const apiKey = Deno.env.get('OPEN_METEO_API_KEY') || '';
        const base = apiKey
            ? 'https://customer-api.open-meteo.com/v1/forecast'
            : 'https://api.open-meteo.com/v1/forecast';
        const keyParam = apiKey ? `&apikey=${apiKey}` : '';
        const url = `${base}?latitude=${lat}&longitude=${lon}&current=${WEATHER_VARS}&wind_speed_unit=kmh&timezone=auto${keyParam}`;
        const res = await fetchWithTimeout(url, {}, 10_000);
        if (!res.ok) {
            console.warn(`Open-Meteo error: ${res.status}`);
            await res.body?.cancel().catch(() => undefined);
            return null;
        }
        const data = await readResponseJsonObjectLimited(res, MAX_WEATHER_RESPONSE_BYTES);
        return data ? parseWeatherCurrent(data) : null;
    } catch {
        console.error('Weather fetch failed');
        return null;
    }
}

// ── Round coordinates to 0.1° for dedup (nearby users share weather) ──
function roundCoord(v: number): number {
    return Math.round(v * 10) / 10;
}

type JsonRecord = Record<string, unknown>;

interface AlertPreference {
    enabled: boolean;
    threshold?: number;
}

interface AlertLocation {
    lat: number;
    lon: number;
    name: string;
}

interface UserAlert {
    userId: string;
    lat: number;
    lon: number;
    notifications: Record<string, AlertPreference>;
    locationName: string;
}

interface UserSettingsRow {
    user_id: string;
    settings: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function finiteCoordinate(value: unknown, axis: 'lat' | 'lon'): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const bound = axis === 'lat' ? 90 : 180;
    return Math.abs(value) <= bound ? value : null;
}

/**
 * Alert configuration is user preference data, so malformed or stale JSON must
 * be ignored rather than taking the cron down. Only enabled alerts with finite
 * numeric thresholds are retained; precipitation is threshold-free.
 */
function parseAlertPreferences(value: unknown): Record<string, AlertPreference> | null {
    const notifications = asRecord(value);
    if (!notifications) return null;

    const parsed: Record<string, AlertPreference> = {};
    for (const [key, rawPreference] of Object.entries(notifications)) {
        const preference = asRecord(rawPreference);
        if (!preference || preference.enabled !== true) continue;
        const threshold = preference.threshold;
        parsed[key] = {
            enabled: true,
            ...(typeof threshold === 'number' && Number.isFinite(threshold) ? { threshold } : {}),
        };
    }

    return Object.keys(parsed).length > 0 ? parsed : null;
}

/**
 * `defaultLocationCoords` is the current app setting. The object-shaped
 * `defaultLocation` fallback keeps already-synchronised legacy settings
 * working while clients update to the dedicated user_settings table.
 */
function configuredLocation(settings: JsonRecord): AlertLocation | null {
    const currentCoords = asRecord(settings.defaultLocationCoords);
    const legacyLocation = asRecord(settings.defaultLocation);
    const coords = currentCoords ?? legacyLocation;
    if (!coords) return null;

    const lat = finiteCoordinate(coords.lat, 'lat');
    const lon = finiteCoordinate(coords.lon, 'lon');
    if (lat === null || lon === null) return null;

    const currentName = typeof settings.defaultLocation === 'string' ? settings.defaultLocation.trim() : '';
    const legacyName = typeof legacyLocation?.name === 'string' ? legacyLocation.name.trim() : '';
    return { lat, lon, name: currentName || legacyName || 'Your location' };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
    return chunks;
}

/**
 * Fetch the Guardian fallback positions in bounded batches. This replaces the
 * previous N+1 `.single()` lookup and deliberately treats Guardian as a
 * fallback: a transient Guardian failure must not suppress users who supplied
 * a saved default location in user_settings.
 */
async function guardianLocationsForUsers(
    supabase: ReturnType<typeof createClient>,
    userIds: readonly string[],
): Promise<Map<string, AlertLocation>> {
    const locations = new Map<string, AlertLocation>();
    for (const ids of chunk([...new Set(userIds)], 200)) {
        if (ids.length === 0) continue;
        const { data, error } = await supabase
            .from('guardian_profiles')
            .select('user_id, last_known_lat, last_known_lon')
            .in('user_id', ids);
        if (error) {
            console.warn('Guardian fallback lookup failed:', error.message);
            continue;
        }

        for (const row of data ?? []) {
            const lat = finiteCoordinate(row.last_known_lat, 'lat');
            const lon = finiteCoordinate(row.last_known_lon, 'lon');
            if (lat === null || lon === null || typeof row.user_id !== 'string') continue;
            locations.set(row.user_id, { lat, lon, name: 'Your location' });
        }
    }
    return locations;
}

serve(async (req: Request) => {
    const startTime = Date.now();
    const authorizationFailure = requireServiceRolePost(req, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (authorizationFailure) return authorizationFailure;

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ error: 'Server database is not configured' }, 500);
        }
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        // ── 1. Get all users with at least one alert enabled ──
        // Settings used to live in an undeployed `profiles` table. The
        // user_settings contract is now the cloud authority, so this cron must
        // fail closed (no alert) for rows without a valid opt-in rather than
        // failing the entire scheduled run because a retired table is absent.
        const { data: settingsRows, error: settingsError } = await supabase
            .from('user_settings')
            .select('user_id, settings');

        if (settingsError) {
            console.error('Failed to fetch user settings:', settingsError);
            return jsonResponse({ error: 'Settings fetch failed' }, 500);
        }

        if (!settingsRows || settingsRows.length === 0) {
            return jsonResponse({ checked: 0, message: 'No user settings' });
        }

        interface AlertUserCandidate {
            userId: string;
            notifications: Record<string, AlertPreference>;
            location: AlertLocation | null;
        }

        // Filter to users with ≥1 alert enabled. Resolve Guardian positions in
        // one bounded batch after inspecting the saved location configuration.
        const candidates: AlertUserCandidate[] = [];
        for (const row of settingsRows as UserSettingsRow[]) {
            if (!row || typeof row.user_id !== 'string') continue;
            const settings = asRecord(row.settings);
            if (!settings) continue;
            const notifications = parseAlertPreferences(settings.notifications);
            if (!notifications) continue;
            candidates.push({
                userId: row.user_id,
                notifications,
                location: configuredLocation(settings),
            });
        }

        const guardianLocations = await guardianLocationsForUsers(
            supabase,
            candidates.filter((candidate) => !candidate.location).map((candidate) => candidate.userId),
        );

        const usersToCheck: UserAlert[] = [];
        for (const candidate of candidates) {
            const location = candidate.location ?? guardianLocations.get(candidate.userId);
            if (!location) continue; // Can't alert without a configured or Guardian location.
            usersToCheck.push({
                userId: candidate.userId,
                lat: location.lat,
                lon: location.lon,
                notifications: candidate.notifications,
                locationName: location.name,
            });
        }

        if (usersToCheck.length === 0) {
            return jsonResponse({ checked: 0, message: 'No users with alerts + location' });
        }

        // ── 2. Deduplicate weather fetches by rounded coord ──
        const weatherCache = new Map<string, Record<string, number | null> | null>();

        async function getWeather(lat: number, lon: number): Promise<Record<string, number | null> | null> {
            const key = `${roundCoord(lat)},${roundCoord(lon)}`;
            if (weatherCache.has(key)) return weatherCache.get(key)!;

            const weather = await fetchWeather(roundCoord(lat), roundCoord(lon));
            weatherCache.set(key, weather);
            return weather;
        }

        // ── 3. Check each user's thresholds ──
        const today = new Date().toISOString().split('T')[0]; // '2026-03-19'
        let alertsQueued = 0;
        let usersChecked = 0;

        // Rate limit: max 60 Open-Meteo requests per run
        const MAX_WEATHER_REQS = 60;
        let weatherReqs = 0;

        for (const user of usersToCheck) {
            const weatherKey = `${roundCoord(user.lat)},${roundCoord(user.lon)}`;
            const needsWeatherFetch = !weatherCache.has(weatherKey);
            if (weatherReqs >= MAX_WEATHER_REQS && needsWeatherFetch) {
                continue; // Skip if we'd exceed rate limit
            }

            // Count a cache miss before issuing it, including a failed request.
            // The former post-fetch increment accidentally counted cache hits
            // as requests and could stop checking sailors sharing one location.
            if (needsWeatherFetch) weatherReqs++;

            const weather = await getWeather(user.lat, user.lon);
            if (!weather) continue;
            usersChecked++;

            for (const check of ALERT_CHECKS) {
                const setting = user.notifications[check.setting];
                if (!setting?.enabled) continue;

                const value = check.getValue(weather);
                if (value == null) continue;

                const threshold = setting.threshold;

                // Precipitation is a boolean check (no threshold)
                let triggered = false;
                if (check.type === 'precipitation') {
                    triggered = value >= 1;
                } else if (threshold != null) {
                    triggered = check.compare === 'gte' ? value >= threshold : value <= threshold;
                }

                if (!triggered) continue;

                // ── 4. Atomically claim the daily alert slot ──
                const alertKey =
                    check.type === 'precipitation'
                        ? `precip-${weatherCodeToDescription(weather.weather_code ?? 0)}-${today}`
                        : `${check.type}-${check.formatValue(value)}${check.unit}-${today}`;

                // `weather_alerts_log` has a `(user_id, alert_key)` unique
                // constraint. Claim it before enqueueing the push so two
                // overlapping cron invocations cannot both notify the same
                // skipper after each observed an empty pre-check.
                const { data: claimedAlert, error: claimError } = await supabase
                    .from('weather_alerts_log')
                    .upsert(
                        {
                            user_id: user.userId,
                            alert_type: check.type,
                            alert_key: alertKey,
                        },
                        { onConflict: 'user_id,alert_key', ignoreDuplicates: true },
                    )
                    .select('id')
                    .maybeSingle();
                if (claimError) {
                    console.error(`Weather alert dedup claim failed for ${user.userId}:`, claimError);
                    continue;
                }
                if (!claimedAlert) continue; // An overlapping run already owns this alert.

                // ── 5. Build alert message ──
                let title: string;
                let body: string;

                if (check.type === 'precipitation') {
                    const condition = weatherCodeToDescription(weather.weather_code ?? 0);
                    title = `${check.emoji} ${condition} Detected`;
                    body = `Current conditions at ${user.locationName}: ${condition}`;
                } else {
                    const valueStr = check.formatValue(value);
                    title = `${check.emoji} ${check.label}: ${valueStr}${check.unit}`;
                    body =
                        check.compare === 'gte'
                            ? `${check.label} at ${user.locationName} has exceeded your ${threshold}${check.unit} threshold.`
                            : `${check.label} at ${user.locationName} has dropped below your ${threshold}${check.unit} threshold.`;
                }

                // Determine if this should be a critical alert
                const isSevere = (check.type === 'wind' && value >= 50) || (check.type === 'gusts' && value >= 65);

                // ── 6. Queue push notification ──
                const { error: insertError } = await supabase.from('push_notification_queue').insert({
                    recipient_user_id: user.userId,
                    notification_type: isSevere ? 'severe_weather_alert' : 'weather_alert',
                    title,
                    body,
                    data: {
                        alert_type: check.type,
                        value,
                        threshold,
                        location: user.locationName,
                        lat: user.lat,
                        lon: user.lon,
                        is_severe: isSevere,
                    },
                });

                if (insertError) {
                    console.error(`Push queue insert failed for ${user.userId}:`, insertError);
                } else {
                    alertsQueued++;
                    console.log(`Alert queued: ${check.type} for user ${user.userId.slice(0, 8)}…`);
                }
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(
            `Weather check complete: ${usersChecked} users, ${weatherCache.size} locations, ${alertsQueued} alerts in ${elapsed}ms`,
        );

        return jsonResponse({
            checked: usersChecked,
            locations: weatherCache.size,
            alerts: alertsQueued,
            elapsed_ms: elapsed,
        });
    } catch {
        console.error('check-weather-alerts failed');
        return jsonResponse({ error: 'Weather alert check failed' }, 500);
    }
});
