/**
 * Tides tool — next high + low tide for a location.
 *
 * Uses the existing fetchRealTides() pipeline (WorldTides API,
 * 24-hour cache) so this tool is essentially free at the cache layer
 * — most of the time it's a localStorage hit.
 *
 * Returns next two extremes (typically one high + one low, but the
 * order depends on time of day): time, type, height, and a hours-from-
 * now label for natural read-back ("high tide in two hours, one point
 * eight metres").
 *
 * Lat/lon resolution priority:
 *   1. Caller-supplied lat/lon (when the LLM has them from
 *      thalassaContext or saved locations).
 *   2. NMEA fix (live boat position).
 *   3. Phone GPS fallback.
 *   4. Error if none — Calypso says so.
 */

import { fetchRealTides } from '../../weather/api/tides';
import { getCurrentFix } from './voyage';

export async function getTides(
    lat?: number,
    lon?: number,
    locationName?: string,
): Promise<{ content: string; isError: boolean }> {
    let resolvedLat = lat;
    let resolvedLon = lon;
    let source: 'caller' | 'nmea' | 'phone' = 'caller';

    if (!isFinite(resolvedLat ?? NaN) || !isFinite(resolvedLon ?? NaN)) {
        const fix = await getCurrentFix();
        if (!fix) {
            return {
                content: JSON.stringify({
                    status: 'no_location',
                    note: 'No location supplied and no live GPS. Ask the skipper which port they want tides for.',
                }),
                isError: false,
            };
        }
        resolvedLat = fix.lat;
        resolvedLon = fix.lon;
        source = fix.source;
    }

    try {
        const result = await fetchRealTides(resolvedLat as number, resolvedLon as number);
        const now = Date.now();
        // fetchRealTides returns past + future extremes (14-day window).
        // Filter to upcoming only and take next two — typically one
        // high + one low. We sort so the very-next one is first.
        const upcoming = (result.tides || [])
            .filter((t) => new Date(t.time).getTime() > now)
            .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
            .slice(0, 4); // up to 4 so Calypso can mention "next two highs are X and Y" if asked

        if (upcoming.length === 0) {
            return {
                content: JSON.stringify({
                    status: 'no_predictions',
                    note: 'WorldTides returned nothing for this location. Could be inland or no tide station nearby. Say so plainly.',
                }),
                isError: false,
            };
        }

        const enriched = upcoming.map((t) => {
            const dt = new Date(t.time);
            const hoursFromNow = (dt.getTime() - now) / 3_600_000;
            return {
                time_iso: t.time,
                time_local: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                type: t.type, // 'high' | 'low'
                height_m: t.height,
                hours_from_now: Number(hoursFromNow.toFixed(1)),
                hours_label: formatHoursLabel(hoursFromNow),
            };
        });

        return {
            content: JSON.stringify({
                status: 'tides',
                station_name: result.guiDetails?.stationName ?? 'unknown station',
                position_source: source,
                location_name: locationName ?? '',
                lat: resolvedLat,
                lon: resolvedLon,
                next: enriched[0],
                upcoming: enriched, // Up to 4 entries — first is next, rest for context
                note: 'Read the next tide naturally — "high tide in two hours forty, one point eight metres". Don\'t list all four unless the skipper asks for "next few" or similar.',
            }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: tides lookup failed — ${(err as Error).message}`, isError: true };
    }
}

function formatHoursLabel(h: number): string {
    if (!isFinite(h)) return 'unknown';
    if (h < 0) return 'past';
    const totalMin = Math.round(h * 60);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hours === 0) {
        if (mins === 0) return 'now';
        return `in ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
    }
    if (mins === 0) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    return `in ${hours} ${hours === 1 ? 'hour' : 'hours'} ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
}
