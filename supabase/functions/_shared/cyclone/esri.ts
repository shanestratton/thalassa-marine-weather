/**
 * The forecast-position layer of the Esri "Active Hurricanes, Cyclones and
 * Typhoons" feed (services9.arcgis.com …/Active_Hurricanes_v1, layer 0), read
 * the same way by the app's storm layer and by cyclone-watch (129-09).
 *
 * The feed carries NHC/CPHC points for AL, EP and CP (BASIN), and JTWC points
 * for WP, IO and SH. The centres' own products are US Government public
 * domain, but this item is Esri's: licensed under the Esri Master License
 * Agreement and credited "NHC, JTWC, Esri" (item 248e7b5827a34b248647afb012c58787,
 * read 2026-10-14), so whatever draws it credits Esri as well (see centres.ts).
 * Times come from VALIDTIME, which is UTC (see esriValidTime).
 */
import { esriTrackIssuer, esriValidTime, type TrackIssuer } from './centres.ts';

export interface EsriPoint {
    lat: number;
    lon: number;
    time: string;
    windKts: number | null;
    pressureMb: number | null;
}

export interface EsriForecastStorm {
    /** Basin and number, "EP41" or "SH05": the a-deck key, without the year. */
    key: string;
    /** Upper case, as the app matches names. */
    name: string;
    issuer: TrackIssuer;
    /** NHC's advisory number, or the issue time where the feed has none (JTWC). */
    advisory: string;
    issued: string | null;
    points: EsriPoint[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The storm's key, as cyclone_watch_alerts stores it (^[A-Z0-9]{2,12}$):
 * basin and number, or, where the feed leaves STORMNUM empty, the name with
 * its accents and punctuation taken out ("TWENTY-ONE-E" → "TWENTYONEE").
 */
function stormKey(basin: string, n: number | null, name: string): string | null {
    if (/^[A-Z]{2}$/.test(basin) && n !== null && Number.isInteger(n) && n >= 0 && n < 100) {
        return `${basin}${String(n).padStart(2, '0')}`;
    }
    const plain = name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12);
    return plain.length >= 2 ? plain : null;
}

/** A label with no zone, or in UTC, read as UTC; a local label ("… MST") is not read. */
function utcLabelTime(label: unknown): string {
    const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)(?:\s+\w{3})?(?:\s+(\w+))?\s*$/i.exec(
        String(label ?? ''),
    );
    if (!m || (m[7] && !/^(UTC|GMT|Z)$/i.test(m[7]))) return '';
    let h = +m[4] % 12;
    if (m[6].toUpperCase() === 'PM') h += 12;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[5]);
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

export function parseEsriForecast(geojson: unknown): EsriForecastStorm[] {
    const features = (geojson as { features?: unknown[] } | null)?.features;
    const storms = new Map<string, EsriForecastStorm>();
    const basins = new Map<string, string>();
    for (const f of Array.isArray(features) ? features : []) {
        const p = (f as { properties?: Record<string, unknown> })?.properties;
        const xy = (f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates;
        const name = typeof p?.STORMNAME === 'string' ? p.STORMNAME.trim().toUpperCase() : '';
        if (!p || !name || !Array.isArray(xy) || num(xy[0]) === null || num(xy[1]) === null) continue;
        const basin = String(p.BASIN ?? '').trim().toUpperCase();
        const key = stormKey(basin, num(p.STORMNUM), name);
        if (!key) continue;
        const adv = num(p.ADVDATE);
        const issued = adv === null ? null : new Date(adv).toISOString();
        let s = storms.get(key);
        if (!s) {
            const advNum = String(p.ADVISNUM ?? '').trim();
            s = { key, name, issuer: esriTrackIssuer(basin), advisory: advNum || issued || '', issued, points: [] };
            basins.set(key, basin);
            storms.set(key, s);
        }
        const wind = num(p.MAXWIND);
        const mslp = num(p.MSLP);
        s.points.push({
            lat: xy[1] as number,
            lon: xy[0] as number,
            time: esriValidTime(p.VALIDTIME, p.ADVDATE) ?? utcLabelTime(p.FLDATELBL),
            windKts: wind !== null && wind > 0 ? wind : null,
            pressureMb: mslp !== null && mslp > 0 && mslp < 9999 ? mslp : null,
        });
    }
    for (const s of storms.values()) {
        s.points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        // NHC or CPHC by where the storm is now (tau 0), not by its id.
        s.issuer = esriTrackIssuer(basins.get(s.key), s.points[0]?.lat, s.points[0]?.lon);
    }
    return [...storms.values()];
}
