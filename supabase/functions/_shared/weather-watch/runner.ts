import { cachedConvectiveMember, weatherWatchCell } from '../../../../utils/cachedConvective.ts';
import { convectiveConsensus, convectiveContext, type ConvectiveMember } from '../../../../utils/convective.ts';
import {
    parseWeatherWatchPreferences,
    rainArrival,
    validRainPayload,
    type WeatherWatchFeature,
    weatherWatchLocalSlot,
} from '../../../../utils/weatherWatch.ts';
import { composeBriefing } from '../../../../services/briefing/composeBriefing.ts';
import { officialCovers, type OfficialForCover } from '../forecast-alerts/cover.ts';
import {
    WEATHER_POSITION_HOLD_MS,
    weatherPositionFix,
    weatherPositionUuid,
} from '../../../../utils/weatherPosition.ts';
export interface WatchWork {
    boat_id: string;
    owner_id: string;
    revision: string;
    preferences: unknown;
    position?: unknown;
}
export interface WatchClaim {
    p_boat_id: string;
    p_revision: string;
    p_feature: WeatherWatchFeature;
    p_sample: string;
    p_event: string;
    p_source_at: string;
    p_expires: string;
    p_title: string;
    p_body: string;
    p_position_revision?: string | null;
    p_position_at?: string | null;
}
export interface WeatherWatchDeps {
    now(): number;
    /** Bounded private work pages. No client may submit coordinates to a cron. */
    work(feature: WeatherWatchFeature, after: string | null, limit: number): Promise<WatchWork[]>;
    forecasts(cell: string): Promise<unknown[]>;
    rain(lat: number, lon: number): Promise<{ body: unknown; retrievedAt: number } | null>;
    /** Existing cached official match/delivery tables only; missing coverage never means all clear. */
    official(owner: string, lat: number, lon: number): Promise<{ live: boolean; delivered: OfficialForCover[] }>;
    claim(input: WatchClaim): Promise<boolean>;
    tick(feature: WeatherWatchFeature, success: boolean): Promise<void>;
}
/** No free/provider fallback. Missing cached fields are unknown; work/claim recheck live opt-in. */
export async function runWeatherWatch(feature: WeatherWatchFeature, deps: WeatherWatchDeps) {
    // Reserve time inside the55s cron invocation for one bounded response
    // and the final heartbeat. No event may be claimed after this work budget.
    const now = deps.now(), deadline = now + 30_000;
    let after: string | null = null, checked = 0, queued = 0, complete = true;
    const cells = new Map<string, Promise<ConvectiveMember[]>>();
    const forecast = (lat: number, lon: number) => {
        const cell = weatherWatchCell(lat, lon);
        let promise = cells.get(cell);
        if (!promise) {
            if (cells.size >= 256) {
                complete = false;
                return Promise.resolve([]);
            }
            promise = deps.forecasts(cell).then((rows) =>
                rows.map((row) => cachedConvectiveMember(row, cell, now)).filter((m): m is ConvectiveMember => !!m)
            );
            cells.set(cell, promise);
        }
        return promise;
    };
    try {
        // 160 explicitly registered vessels/run; over-capacity is an unhealthy run,
        // never a success heartbeat hiding omitted vessels. Activation must size cron batches first.
        for (let page = 0; page < 11; page++) {
            const rows = await deps.work(feature, after, 16);
            if (!Array.isArray(rows) || rows.length > 16) throw new Error('Invalid work page');
            if (!rows.length) break;
            if (page === 10 || deps.now() > deadline) {
                complete = false;
                break;
            }
            for (const row of rows) {
                if (deps.now() > deadline) {
                    complete = false;
                    break;
                }
                const prefs = parseWeatherWatchPreferences(row.preferences, now);
                if (!prefs || !prefs[feature]) continue;
                checked++;
                const rawPosition = row.position && typeof row.position === 'object'
                    ? row.position as Record<string, unknown>
                    : null;
                const fix = weatherPositionFix(rawPosition, now, WEATHER_POSITION_HOLD_MS);
                const position =
                    fix && weatherPositionUuid(rawPosition?.revision) && typeof rawPosition.zone === 'string' &&
                        weatherWatchLocalSlot(now, rawPosition.zone)
                        ? { ...fix, revision: rawPosition.revision, zone: rawPosition.zone }
                        : null;
                // A short manually selected position never becomes overnight coverage.
                if ((feature === 'morning' || feature === 'rain') && !position) continue;
                const zone = position?.zone ?? prefs.zone;
                const local = weatherWatchLocalSlot(now, zone);
                if (!local || (feature === 'morning' && (local.hour !== prefs.hour || local.minute > 9))) continue;
                const samples = position
                    ? [{
                        key: 'live:boat',
                        kind: 'boat' as const,
                        label: 'Your registered vessel',
                        lat: position.lat,
                        lon: position.lon,
                        sourceAt: position.at,
                        expiresAt: position.at + WEATHER_POSITION_HOLD_MS,
                    }, ...prefs.samples.filter((s) => s.kind !== 'boat')]
                    : prefs.samples;
                for (const sample of samples) {
                    if (sample.expiresAt <= now || (['morning', 'rain'].includes(feature) && sample.kind !== 'boat')) {
                        continue;
                    }
                    let event: { key: string; source: number; expires: number; title: string; body: string } | null =
                        null;
                    if (feature === 'rain') {
                        const response = await deps.rain(sample.lat, sample.lon);
                        if (!response || !validRainPayload(response.body, sample.lat, sample.lon, deps.now())) {
                            throw new Error('Invalid nowcast');
                        }
                        const arrival = response && rainArrival(response.body, response.retrievedAt, now);
                        if (arrival) {
                            const when = new Intl.DateTimeFormat('en-GB', {
                                timeZone: zone,
                                hour: '2-digit',
                                minute: '2-digit',
                                hourCycle: 'h23',
                            }).format(arrival.from);
                            event = {
                                key: `${sample.key}:${Math.floor(arrival.from / 3_600_000)}`,
                                source: arrival.sourceAt,
                                expires: Math.min(arrival.expiresAt, now + 5 * 60_000),
                                title: 'Forecast: rain arriving',
                                body:
                                    `Rain may reach your registered boat position around ${when} (${zone}). Rainbow nowcast; not lightning detection.`,
                            };
                        }
                    } else {
                        const members = await forecast(sample.lat, sample.lon);
                        if (deps.now() > deadline) {
                            complete = false;
                            break;
                        }
                        if (!members.length) continue;
                        const source = Math.min(...members.map((m) => m.runAt));
                        const official = await deps.official(row.owner_id, sample.lat, sample.lon);
                        if (feature === 'morning') {
                            const briefing = composeBriefing({
                                place: sample.label,
                                zone,
                                now,
                                forecastAt: source,
                                official: official.live
                                    ? {
                                        state: 'live',
                                        headline:
                                            'In force for the registered place; open Warnings for issuer details.',
                                        checkedAt: now,
                                    }
                                    : { state: 'unavailable' },
                                convective: convectiveContext(
                                    members,
                                    Math.floor(now / 3_600_000) * 3_600_000,
                                    sample.lat,
                                    now,
                                ),
                                models: members.map((m) => m.model),
                            });
                            event = {
                                key: local.day,
                                source,
                                expires: now + 3_600_000,
                                title: 'Your morning weather briefing',
                                body: briefing.lines.join('\n'),
                            };
                        } else {
                            const agreed = convectiveConsensus(members, now, prefs.gustKts).find((e) =>
                                e.kind === feature
                            );
                            if (!agreed) continue;
                            if (
                                officialCovers([feature === 'storm' ? 'thunderstorm' : 'wind', 1], official.delivered)
                            ) continue;
                            // Quiet hours use the registered boat zone, the same imminent <=3h rule as129-07.
                            if ((local.hour >= 22 || local.hour < 7) && agreed.from > now + 3 * 3_600_000) continue;
                            const start = new Intl.DateTimeFormat('en-GB', {
                                timeZone: zone,
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                                hourCycle: 'h23',
                            }).format(agreed.from);
                            const names = agreed.models.map(
                                (m) => ({
                                    ecmwf_ifs025: 'ECMWF',
                                    dwd_icon: 'ICON',
                                    ukmo_global_deterministic_10km: 'UKMO',
                                }[m]),
                            ).join(', ');
                            event = {
                                key: `${sample.key}:${agreed.from}`,
                                source,
                                expires: Math.min(agreed.to, now + 3_600_000),
                                title: `Forecast: ${
                                    feature === 'storm' ? 'thunderstorm risk' : 'gust threshold crossed'
                                }`,
                                body:
                                    `${agreed.models.length} of 3 models agree (${names}) near ${sample.label}, ${start} (${zone}). ${
                                        feature === 'storm'
                                            ? 'Thunder forecast, not lightning detection.'
                                            : 'Your gust threshold, not a measured gust.'
                                    } Sampled 0.25° forecast cells; gaps between samples are not checked.`,
                            };
                        }
                    }
                    if (deps.now() > deadline) {
                        complete = false;
                        break;
                    }
                    if (
                        event &&
                        await deps.claim({
                            p_boat_id: row.boat_id,
                            p_revision: row.revision,
                            p_feature: feature,
                            p_sample: sample.key,
                            p_event: event.key,
                            p_source_at: new Date(event.source).toISOString(),
                            p_expires: new Date(Math.min(event.expires, sample.expiresAt)).toISOString(),
                            p_title: event.title,
                            p_body: event.body,
                            p_position_revision: sample.key === 'live:boat' ? position!.revision : null,
                            p_position_at: sample.key === 'live:boat' ? new Date(position!.at).toISOString() : null,
                        })
                    ) queued++;
                }
            }
            after = rows.at(-1)!.boat_id;
            if (!complete || rows.length < 16) break;
        }
        await deps.tick(feature, complete);
        return { checked, queued, complete };
    } catch {
        await deps.tick(feature, false).catch(() => undefined);
        throw new Error('Weather watch unavailable'); // No upstream URL, coordinates or key in public errors.
    }
}
