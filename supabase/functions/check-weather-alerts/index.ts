/**
 * check-weather-alerts — Server-Side Weather Alert Cron
 *
 * Runs every 30 minutes via pg_cron → pg_net HTTP POST.
 * For each user with ≥1 alert threshold enabled:
 *   1. Read their location (defaultLocation or Guardian last_known)
 *   2. Fetch current weather from Open-Meteo
 *   3. Evaluate thresholds from profiles.settings.notifications
 *   4. Dedup against weather_alerts_log (skip if alerted in last 6h)
 *   5. Insert into push_notification_queue → triggers send-push webhook
 *
 * This ensures alerts fire even when the app is backgrounded/closed.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Open-Meteo weather variables we need ──
const WEATHER_VARS = [
    'weather_code',
    'temperature_2m',
    'wind_speed_10m',
    'wind_gusts_10m',
    'visibility',
    'uv_index',
].join(',');

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
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`Open-Meteo error: ${res.status}`);
            return null;
        }
        const data = await res.json();
        return data?.current || null;
    } catch (err) {
        console.error('Weather fetch failed:', err);
        return null;
    }
}

// ── Round coordinates to 0.1° for dedup (nearby users share weather) ──
function roundCoord(v: number): number {
    return Math.round(v * 10) / 10;
}

serve(async (req: Request) => {
    const startTime = Date.now();

    try {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

        // ── 1. Get all users with at least one alert enabled ──
        const { data: profiles, error: profilesError } = await supabase.from('profiles').select('id, settings');

        if (profilesError) {
            console.error('Failed to fetch profiles:', profilesError);
            return new Response(JSON.stringify({ error: 'Profile fetch failed' }), { status: 500 });
        }

        if (!profiles || profiles.length === 0) {
            return new Response(JSON.stringify({ checked: 0, message: 'No profiles' }), { status: 200 });
        }

        // Filter to users with ≥1 alert enabled AND a location
        interface UserAlert {
            userId: string;
            lat: number;
            lon: number;
            notifications: Record<string, { enabled: boolean; threshold?: number }>;
            locationName: string;
        }

        const usersToCheck: UserAlert[] = [];

        for (const profile of profiles) {
            const settings = profile.settings;
            if (!settings?.notifications) continue;

            const notifs = settings.notifications;
            const hasAnyEnabled = Object.values(notifs).some((n: { enabled?: boolean }) => n?.enabled === true);
            if (!hasAnyEnabled) continue;

            // Get location: defaultLocation first, then try guardian last_known
            let lat: number | null = null;
            let lon: number | null = null;
            let locationName = 'Your location';

            if (settings.defaultLocation?.lat && settings.defaultLocation?.lon) {
                lat = settings.defaultLocation.lat;
                lon = settings.defaultLocation.lon;
                locationName = settings.defaultLocation.name || locationName;
            }

            // Fallback: Try guardian last_known
            if (lat == null || lon == null) {
                const { data: guardian } = await supabase
                    .from('guardian_profiles')
                    .select('last_known_lat, last_known_lon')
                    .eq('user_id', profile.id)
                    .single();

                if (guardian?.last_known_lat && guardian?.last_known_lon) {
                    lat = guardian.last_known_lat;
                    lon = guardian.last_known_lon;
                }
            }

            if (lat == null || lon == null) continue; // Can't alert without location

            usersToCheck.push({
                userId: profile.id,
                lat,
                lon,
                notifications: notifs,
                locationName,
            });
        }

        if (usersToCheck.length === 0) {
            return new Response(JSON.stringify({ checked: 0, message: 'No users with alerts + location' }), {
                status: 200,
            });
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
            if (
                weatherReqs >= MAX_WEATHER_REQS &&
                !weatherCache.has(`${roundCoord(user.lat)},${roundCoord(user.lon)}`)
            ) {
                continue; // Skip if we'd exceed rate limit
            }

            const weather = await getWeather(user.lat, user.lon);
            if (!weather) continue;
            weatherReqs++; // Only count actual fetches
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

                // ── 4. Dedup check ──
                const alertKey =
                    check.type === 'precipitation'
                        ? `precip-${weatherCodeToDescription(weather.weather_code ?? 0)}-${today}`
                        : `${check.type}-${check.formatValue(value)}${check.unit}-${today}`;

                const { data: existing } = await supabase
                    .from('weather_alerts_log')
                    .select('id')
                    .eq('user_id', user.userId)
                    .eq('alert_key', alertKey)
                    .maybeSingle();

                if (existing) continue; // Already alerted

                // ── 5. Insert dedup record ──
                await supabase.from('weather_alerts_log').insert({
                    user_id: user.userId,
                    alert_type: check.type,
                    alert_key: alertKey,
                });

                // ── 6. Build alert message ──
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

                // ── 7. Queue push notification ──
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

        return new Response(
            JSON.stringify({
                checked: usersChecked,
                locations: weatherCache.size,
                alerts: alertsQueued,
                elapsed_ms: elapsed,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
    } catch (error) {
        console.error('check-weather-alerts error:', error);
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
});
