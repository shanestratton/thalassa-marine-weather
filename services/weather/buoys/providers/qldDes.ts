/**
 * Queensland's wave monitoring network (build 123, W1-11).
 *
 * The Department of the Environment's 7-day CSV
 * (apps.des.qld.gov.au/data-sets/waves/wave-7dayopdata.csv, ~1 MB) is
 * re-ingested into the Queensland open-data portal's CKAN resource
 * 2bbef99e-9974-49b9-a316-57402b00609c every few minutes, so this resource is
 * LIVE — unlike the CKAN copies of the tide gauges, which froze in 2019.
 * Measured 2026-10-07: same newest rows as the CSV, `last_modified` = now,
 * 26 sites, CORS `*`. Asking it for the newest 200 rows (~32 KB, every site's
 * last ~3.5 h) beats downloading the 1 MB CSV on a phone.
 *
 * MEASURED TRAPS:
 *  - the height column is `Hsig` one day and `Hs` the next (both seen within
 *    24 h), so both are read;
 *  - `DateTime` is Queensland local time with no zone, in two formats; the
 *    `Seconds` column is the UTC epoch and is the only time used;
 *  - `-99.90` fills missing values (always for the current columns);
 *  - port buoys report `0.00000, 0.00000` when their GPS drops (QC skips the
 *    row, so the site's previous row answers).
 *
 * Licence: CC BY 4.0, © State of Queensland — credited as the owner.
 */
import { getBuoyJson } from '../net';
import { reading } from '../qc';
import type { BuoyObs, BuoyProvider } from '../types';

export const QLD_WAVES_URL =
    'https://www.data.qld.gov.au/api/3/action/datastore_search' +
    '?resource_id=2bbef99e-9974-49b9-a316-57402b00609c&sort=Seconds%20desc&limit=200&records_format=lists';

interface CkanResponse {
    success?: boolean;
    result?: { fields?: Array<{ id?: string }>; records?: unknown[] };
}

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const coord = (raw: unknown): number => (text(raw) === '' ? NaN : Number(raw));

/** Every row of a CKAN datastore_search answer, in `lists` or `objects` form. */
export function parseQldDesCkan(json: unknown): BuoyObs[] {
    const result = (json as CkanResponse | null)?.result;
    if (!(json as CkanResponse | null)?.success || !result || !Array.isArray(result.records)) return [];
    const fields = (result.fields ?? []).map((f) => f.id ?? '');
    const out: BuoyObs[] = [];
    for (const record of result.records) {
        const row: Record<string, unknown> = Array.isArray(record)
            ? Object.fromEntries(fields.map((name, i) => [name, record[i]]))
            : ((record ?? {}) as Record<string, unknown>);
        const site = text(row.Site);
        const seconds = reading(row.Seconds);
        if (!site || seconds === null) continue;
        const tp = reading(row.Tp);
        out.push({
            key: `qld-des:${text(row.SiteNumber) || site}`,
            network: 'qld-des',
            label: site,
            owner: 'State of Queensland',
            lat: coord(row.Latitude),
            lon: coord(row.Longitude),
            time: seconds * 1000,
            hsM: reading(row.Hs ?? row.Hsig),
            periodS: tp !== null && tp > 0 ? tp : null,
            fromDeg: reading(row.Direction),
            sstC: reading(row.SST),
        });
    }
    return out;
}

export const qldDesProvider: BuoyProvider = {
    id: 'qld-des',
    name: 'Queensland',
    nativeOnly: false,
    coverage: [[-30, 136, -9, 157]],
    async fetchLatest() {
        const json = await getBuoyJson(QLD_WAVES_URL, 'qld-wave-buoys');
        if ((json as CkanResponse | null)?.success !== true) throw new Error('qld-wave-buoys: CKAN refused');
        return parseQldDesCkan(json);
    },
};
