/**
 * Daily briefing tool — Calypso's morning rundown.
 *
 * "Calypso, give me the morning briefing." Aggregates everything
 * relevant to a skipper's situational awareness into one structured
 * response: position, weather, tide, AIS traffic, vessel telemetry.
 * Calypso narrates a 30-second monologue from the resulting object —
 * the kind of thing a real first mate would do over coffee.
 *
 * Internal data flow (parallel where possible):
 *   - Current fix      ← getCurrentFix() (NMEA → phone fallback)
 *   - Tide             ← fetchRealTides() (24h cache)
 *   - AIS traffic      ← AisStore (top 3 within 10nm)
 *   - Vessel telemetry ← NmeaStore current snapshot (battery, depth)
 *   - Weather          ← left to thalassaContext (already in Haiku's
 *                        context as CURRENT THALASSA STATE — cleaner
 *                        than re-fetching here)
 *
 * The tool returns a structured envelope; Calypso composes the
 * monologue from it. We don't pre-compose the prose because Calypso
 * is better at natural narration than a JS template would be.
 */

import { fetchRealTides } from '../../weather/api/tides';
import { AisStore } from '../../AisStore';
import { NmeaStore } from '../../NmeaStore';
import { getCurrentFix } from './voyage';

const EARTH_NM = 3440.065;
function toRad(d: number): number {
    return (d * Math.PI) / 180;
}
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.sqrt(a));
}

export async function dailyBriefing(): Promise<{ content: string; isError: boolean }> {
    const fix = await getCurrentFix();
    const now = new Date();
    const hour = now.getHours();
    const partOfDay = hour < 11 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

    // ── Parallel fetches ───────────────────────────────────────────
    const tidePromise = fix ? fetchRealTides(fix.lat, fix.lon).catch(() => null) : Promise.resolve(null);

    const [tideResult] = await Promise.all([tidePromise]);

    // ── Position summary ───────────────────────────────────────────
    const position = fix
        ? {
              lat: Number(fix.lat.toFixed(4)),
              lon: Number(fix.lon.toFixed(4)),
              source: fix.source,
              sog_kts: fix.sog ?? null,
              cog_deg: fix.cog ?? null,
          }
        : null;

    // ── Tide summary (next high + next low) ────────────────────────
    let tide: {
        next_high?: { time_iso: string; height_m: number; hours_label: string };
        next_low?: { time_iso: string; height_m: number; hours_label: string };
        station_name?: string;
    } | null = null;
    if (tideResult && tideResult.tides && tideResult.tides.length > 0) {
        const upcoming = tideResult.tides
            .filter((t) => new Date(t.time).getTime() > now.getTime())
            .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const nextHigh = upcoming.find((t) => t.type === 'High');
        const nextLow = upcoming.find((t) => t.type === 'Low');
        tide = {
            station_name: tideResult.guiDetails?.stationName,
            ...(nextHigh && {
                next_high: {
                    time_iso: nextHigh.time,
                    height_m: nextHigh.height,
                    hours_label: hoursLabel(new Date(nextHigh.time).getTime() - now.getTime()),
                },
            }),
            ...(nextLow && {
                next_low: {
                    time_iso: nextLow.time,
                    height_m: nextLow.height,
                    hours_label: hoursLabel(new Date(nextLow.time).getTime() - now.getTime()),
                },
            }),
        };
    }

    // ── AIS traffic summary ────────────────────────────────────────
    let ais: { count_within_10nm: number; closest?: { name: string; range_nm: number } } | null = null;
    if (fix) {
        const targets = AisStore.getTargets();
        if (targets && targets.size > 0) {
            const inRange = Array.from(targets.values())
                .map((t) => ({
                    target: t,
                    range_nm: distanceNm(fix.lat, fix.lon, t.lat, t.lon),
                }))
                .filter((x) => x.range_nm <= 10)
                .sort((a, b) => a.range_nm - b.range_nm);
            ais = {
                count_within_10nm: inRange.length,
                ...(inRange.length > 0 && {
                    closest: {
                        name: inRange[0].target.name || `MMSI ${inRange[0].target.mmsi}`,
                        range_nm: Number(inRange[0].range_nm.toFixed(1)),
                    },
                }),
            };
        } else {
            ais = { count_within_10nm: 0 };
        }
    }

    // ── Vessel telemetry snapshot ──────────────────────────────────
    const nm = NmeaStore.getState();
    const telemetry = {
        battery_volts: nm.voltage.freshness === 'live' ? nm.voltage.value : null,
        depth_m: nm.depth.freshness === 'live' ? nm.depth.value : null,
        rpm: nm.rpm.freshness === 'live' ? nm.rpm.value : null,
        nmea_alive: nm.lastAnyUpdate > 0 && Date.now() - nm.lastAnyUpdate < 30_000,
    };

    return {
        content: JSON.stringify({
            status: 'briefing',
            part_of_day: partOfDay,
            time_iso: now.toISOString(),
            position,
            tide,
            ais,
            telemetry,
            note:
                'Compose a 20-30 second briefing. Greet by part-of-day ("Morning, Skipper"). ' +
                'Then weather (you have it from CURRENT THALASSA STATE — quote it briefly), ' +
                'next tide, traffic, vessel state. End with a one-line summary verdict if conditions are notable. ' +
                'Skip empty sections silently — don\'t say "AIS shows nothing" unless they asked. ' +
                "Don't list every number; pick the 3-4 most relevant. Read tide times as 'in two hours forty', " +
                'not as ISO strings.',
        }),
        isError: false,
    };
}

function hoursLabel(ms: number): string {
    if (ms < 0) return 'past';
    const totalMin = Math.round(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `in ${m} ${m === 1 ? 'minute' : 'minutes'}`;
    if (m === 0) return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
    return `in ${h} ${h === 1 ? 'hour' : 'hours'} ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}
