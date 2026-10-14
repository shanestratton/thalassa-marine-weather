/**
 * MeteoAlarm's EMMA_ID outlines (129-05b), from the Geocodes JSON on its
 * Redistribution Hub (https://meteoalarm.org/en/live/page/redistribution-hub),
 * into official_alert_zones, so a European warning that names areas, not a
 * polygon, can be placed instead of reading "partial".
 *
 * Licence: the outlines are the hub's "Content" (EUMETNET's), offered to
 * redistributors as a specification. They are used only to place warnings,
 * credited "Areas: EUMETNET – MeteoAlarm" wherever a MeteoAlarm warning is
 * shown, and never copied into this public repository (the test fixture is
 * fictional boxes). Shane is asking MeteoAlarm to confirm by email.
 *
 * The file is 33 MB (2,006 outlines, 30 countries, 935,750 vertices on
 * 2026-10-14; 196,877 after simplifying), too big for an edge function, so
 * scripts/load-meteoalarm-
 * geocodes.mjs runs this on a computer with the service key, then calls
 * official_alert_zones_sync() per country. The hub's change log moves (for
 * example "2026.07.31 Removal of obsolete geocodes for Israel, Update of
 * geocodes for The Netherlands"): run it again on each new file. An outline
 * that changed is written again, one the file no longer has is removed, and a
 * new one is added. Removing more than half of a country's outlines at once
 * (a whole country, as Israel's were) is refused unless asked for, so a
 * truncated download can never unplace a country.
 */
import { geoJsonToMultiPolygon, prepareGeometry } from './normalize.ts';
import type { ZoneRow } from './ingest.ts';

/** The file loaded with 129-05b (the hub's newest on 2026-10-14). */
export const METEOALARM_GEOCODES_FILE = 'MeteoAlarm_Geocodes_2026_07_31.json';
export const METEOALARM_GEOCODES_URL =
    `https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/${METEOALARM_GEOCODES_FILE}`;
/** The zone keys' scheme: the warnings name their areas "EMMA_ID:FR027" (adapters.ts, capZones). */
export const EMMA_SCHEME = 'EMMA_ID';
/** Outlines per official_alert_zones_sync() call. */
export const ZONE_BATCH = 100;

export interface GeocodeLoad {
    /** Provider id ("meteoalarm-fr") to its outlines, sorted by code, simplified to about 100 m. */
    byProvider: Map<string, ZoneRow[]>;
    /** Features that are not an EMMA_ID outline with a geometry. */
    skipped: number;
}

/**
 * The Geocodes JSON as zone rows per provider, by each feature's country (an
 * Irish code may start EI); null when it is not a FeatureCollection. Codes are
 * two letters and 3 to 6 digits (Poland's PL3009, Czechia's CZ06104).
 */
export function meteoAlarmGeocodeZones(json: unknown, sourceUrl: string): GeocodeLoad | null {
    const fc = json as { type?: unknown; features?: unknown } | null;
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null;
    const byProvider = new Map<string, ZoneRow[]>();
    let skipped = 0;
    for (const f of fc.features as Array<{ properties?: Record<string, unknown>; geometry?: unknown }>) {
        const p = f?.properties ?? {};
        const code = typeof p.code === 'string' ? p.code : '';
        const country = typeof p.country === 'string' ? p.country.toLowerCase() : '';
        const geometry = prepareGeometry(geoJsonToMultiPolygon(f?.geometry));
        if (p.type !== EMMA_SCHEME || !/^[A-Z]{2}\d{3,6}$/.test(code) || !/^[a-z]{2}$/.test(country) || !geometry) {
            skipped++;
            continue;
        }
        const provider = `meteoalarm-${country === 'uk' ? 'gb' : country}`;
        const list = byProvider.get(provider) ?? [];
        list.push({
            code: `${EMMA_SCHEME}:${code}`,
            name: typeof p.name === 'string' ? p.name.slice(0, 300) : null,
            geometry,
            sourceUrl,
        });
        byProvider.set(provider, list);
    }
    for (const list of byProvider.values()) list.sort((a, b) => a.code.localeCompare(b.code));
    return { byProvider, skipped };
}

export interface ZoneSyncPlan {
    provider: string;
    /** Every outline the file has for it: the database writes only the ones that changed. */
    zones: ZoneRow[];
    /** Outlines it has now that the file no longer lists. */
    remove: string[];
    /** Why this provider is not synced (too much would be removed), or null. */
    refuse: string | null;
}

/**
 * What a load changes per provider: `current` is each provider's EMMA_ID codes
 * in official_alert_zones now. A provider losing more than half of what it has
 * is refused unless `allowRemoval` (the hub removes a whole country's outlines
 * now and then; a truncated file must not look like that).
 */
export function planZoneSync(
    current: ReadonlyMap<string, ReadonlySet<string>>,
    next: ReadonlyMap<string, ZoneRow[]>,
    opts: { allowRemoval?: boolean } = {},
): ZoneSyncPlan[] {
    const providers = [...new Set([...current.keys(), ...next.keys()])].sort();
    return providers.map((provider) => {
        const zones = next.get(provider) ?? [];
        const keep = new Set(zones.map((z) => z.code));
        const have = [...(current.get(provider) ?? [])].filter((c) => c.startsWith(`${EMMA_SCHEME}:`));
        const remove = have.filter((c) => !keep.has(c)).sort();
        const refuse = !opts.allowRemoval && remove.length > 0 && remove.length * 2 > have.length
            ? `would remove ${remove.length} of ${have.length} outlines; run again with --allow-removal if the hub's change log says they were removed`
            : null;
        return { provider, zones, remove, refuse };
    });
}

/** official_alert_zones_sync()'s arguments: every code kept goes with every batch, so no batch drops another's. */
export function zoneSyncCalls(
    provider: string,
    zones: readonly ZoneRow[],
    batch = ZONE_BATCH,
): Array<{ p_provider: string; p_scheme: string; p_codes: string[]; p_zones: Record<string, unknown>[] }> {
    const codes = zones.map((z) => z.code).sort();
    const shapes = zones.map((z) => ({
        code: z.code,
        name: z.name,
        geometry: { type: 'MultiPolygon', coordinates: z.geometry },
        source_url: z.sourceUrl,
    }));
    const calls = [];
    for (let i = 0; i < Math.max(shapes.length, 1); i += batch) {
        calls.push({
            p_provider: provider,
            p_scheme: EMMA_SCHEME,
            p_codes: codes,
            p_zones: shapes.slice(i, i + batch),
        });
    }
    return calls;
}
