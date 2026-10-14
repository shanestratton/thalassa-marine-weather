/**
 * A storm in plain words (129-13): which ocean it is in, which storm of the
 * season it is, and how far away it is.
 *
 * The feeds spell a storm the warning centres' way: one ATCF letter for the
 * basin (NHC's 'E', NCEP's TC vitals, a JTWC header) or two (an ATCF id, an
 * older cache), and an id like 'ep202026'. The storm card printed both raw
 * ("E · ep202026", Shane 2026-10-14). These turn them into words.
 */
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';

export type BasinName =
    | 'Atlantic'
    | 'East Pacific'
    | 'Central Pacific'
    | 'West Pacific'
    | 'North Indian'
    | 'South-West Indian'
    | 'Australian region'
    | 'South Pacific'
    | 'South Atlantic';

/** 'south': the southern hemisphere's storms, named by where the storm is (southernRegion). */
const BASIN_BY_CODE: Record<string, BasinName | 'south'> = {
    L: 'Atlantic',
    AL: 'Atlantic',
    AT: 'Atlantic',
    E: 'East Pacific',
    EP: 'East Pacific',
    C: 'Central Pacific',
    CP: 'Central Pacific',
    W: 'West Pacific',
    WP: 'West Pacific',
    A: 'North Indian',
    B: 'North Indian',
    IO: 'North Indian',
    NI: 'North Indian',
    AS: 'North Indian',
    BB: 'North Indian',
    Q: 'South Atlantic',
    SL: 'South Atlantic',
    SA: 'South Atlantic',
    S: 'south',
    P: 'south',
    SH: 'south',
    SI: 'south',
    SP: 'south',
    AU: 'south',
};

/**
 * South of the equator the warning regions go by longitude, not by the ATCF
 * letter (JTWC splits S from P at 135°E; the regions do not): the South-West
 * Indian to 90°E, the Australian region to 160°E, the South Pacific to 70°W,
 * and the South Atlantic from there to 20°E.
 */
export function southernRegion(lon: number): BasinName {
    const east = ((lon % 360) + 360) % 360;
    if (east >= 20 && east < 90) return 'South-West Indian';
    if (east >= 90 && east < 160) return 'Australian region';
    if (east >= 160 && east < 290) return 'South Pacific';
    return 'South Atlantic';
}

const SID = /^([a-z]{2})(\d{2})(\d{4})$/i;

/**
 * The basin in words: from the feed's code, else from the id's two letters,
 * else (south of the equator, or in an ocean with one basin) from where the
 * storm is. Null where none of those can say; never the raw code.
 */
export function basinName(
    code: string | undefined,
    sid: string | undefined,
    lat: number,
    lon: number,
): BasinName | null {
    const fromCode = (raw: string | undefined): BasinName | null => {
        const hit =
            BASIN_BY_CODE[
                String(raw ?? '')
                    .trim()
                    .toUpperCase()
            ];
        if (!hit) return null;
        return hit === 'south' ? southernRegion(lon) : hit;
    };
    const named = fromCode(code) ?? fromCode(SID.exec(String(sid ?? ''))?.[1]);
    if (named) return named;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < 0) return southernRegion(lon);
    const east = ((lon % 360) + 360) % 360;
    if (east >= 30 && east < 100) return 'North Indian';
    if (east >= 100 && east < 180) return 'West Pacific';
    if (east >= 180 && east < 220) return 'Central Pacific';
    // Between the Americas' two coasts longitude alone cannot tell the Atlantic from the East Pacific.
    return null;
}

/** "storm 20", or "invest 93" for a system not yet numbered (90–99); null for an id that carries no number. */
export function stormNumberWords(sid: string | undefined): string | null {
    const m = SID.exec(String(sid ?? ''));
    if (!m) return null;
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 90 ? `invest ${n}` : `storm ${n}`;
}

/** "East Pacific · storm 20": the card's words for which storm this is. */
export function stormIdentityWords(
    code: string | undefined,
    sid: string | undefined,
    lat: number,
    lon: number,
): string {
    const basin = basinName(code, sid, lat, lon);
    const number = stormNumberWords(sid);
    if (basin && number) return `${basin} · ${number}`;
    if (basin) return basin;
    if (number) return number.charAt(0).toUpperCase() + number.slice(1);
    return 'Tropical cyclone';
}

export type StormDistanceSeverity = 'danger' | 'warning' | 'caution' | 'far';

export interface StormDistance {
    nm: number;
    bearing: number;
    /** Eight points: N, NE, E… */
    compass: string;
    /** As the threat chip grades it: under 100 NM danger, 300 warning, 600 caution. */
    severity: StormDistanceSeverity;
    /** "138 NM W", with no-break spaces so "NM W" never wraps away from its number. */
    text: string;
}

export function compassPoint(bearing: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[((Math.round(bearing / 45) % 8) + 8) % 8];
}

/** How far and which way the storm is from (lat, lon); null without both positions. */
export function stormDistance(
    fromLat: number,
    fromLon: number,
    stormLat: number | undefined,
    stormLon: number | undefined,
): StormDistance | null {
    if (![fromLat, fromLon, stormLat, stormLon].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const nm = calculateDistance(fromLat, fromLon, stormLat!, stormLon!);
    const bearing = calculateBearing(fromLat, fromLon, stormLat!, stormLon!);
    const compass = compassPoint(bearing);
    const severity: StormDistanceSeverity = nm < 100 ? 'danger' : nm < 300 ? 'warning' : nm <= 600 ? 'caution' : 'far';
    return { nm, bearing, compass, severity, text: `${Math.round(nm)}\u00a0NM\u00a0${compass}` };
}
