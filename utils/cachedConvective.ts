/** Strict subset of the existing wx2 publication. Never accepts legacy rows or fabricates a run clock. */
import {
    CONVECTIVE_MODELS,
    freshConvectiveMembers,
    type ConvectiveMember,
    type ConvectiveModel,
} from './convective.ts';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const utc = (v: unknown): number => {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(Z|\+00:00)$/.test(v)) return NaN;
    const at = Date.parse(v);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 16) === v.slice(0, 16) ? at : NaN;
};
export function weatherWatchCell(lat: number, lon: number): string {
    return `${Math.floor(lat * 4) * 25}_${Math.floor((lon === 180 ? -180 : lon) * 4) * 25}`;
}
export function cachedConvectiveMember(row: unknown, cell: string, now: number): ConvectiveMember | null {
    if (
        !object(row) ||
        typeof row.model !== 'string' ||
        !row.model.startsWith('wx2:') ||
        row.cell_id !== cell ||
        !CONVECTIVE_MODELS.includes(row.model.slice(4) as ConvectiveModel) ||
        !object(row.payload)
    )
        return null;
    const model = row.model.slice(4) as ConvectiveModel,
        body = row.payload;
    const runAt = utc(row.run_at),
        p = body.thalassa_provenance;
    const [south, west] = cell.split('_').map(Number);
    if (
        !Number.isFinite(runAt) ||
        runAt % (3 * 3_600_000) !== 0 ||
        !object(p) ||
        p.version !== 2 ||
        p.source !== 'wx' ||
        p.model !== model ||
        p.sampling !== 'cell-centre' ||
        p.cell_selection !== 'sea' ||
        p.cell_id !== cell ||
        p.cell_degrees !== 0.25 ||
        p.latitude !== south / 100 + 0.125 ||
        p.longitude !== west / 100 + 0.125 ||
        utc(p.run_at) !== runAt ||
        !Array.isArray(p.source_runs) ||
        p.source_runs.length !== 1 ||
        !object(p.source_runs[0]) ||
        p.source_runs[0].domain !== model ||
        utc(p.source_runs[0].run_at) !== runAt ||
        !Array.isArray(p.source_domains) ||
        p.source_domains.length !== 1 ||
        p.source_domains[0] !== model ||
        !finite(body.latitude) ||
        !finite(body.longitude) ||
        Math.abs(body.latitude) > 90 ||
        Math.abs(body.longitude) > 180 ||
        Math.abs(body.latitude - (south / 100 + 0.125)) > 1 ||
        Math.abs(((body.longitude - (west / 100 + 0.125) + 540) % 360) - 180) > 1 ||
        body.utc_offset_seconds !== 0 ||
        !['GMT', 'UTC', 'Etc/UTC'].includes(String(body.timezone)) ||
        !object(body.hourly) ||
        !object(body.hourly_units) ||
        body.hourly_units.time !== 'iso8601'
    )
        return null;
    const h = body.hourly,
        units = body.hourly_units;
    if (!Array.isArray(h.time) || !h.time.length || h.time.length > 384) return null;
    for (const [field, unit] of [
        ['weather_code', 'wmo code'],
        ['wind_gusts_10m', 'km/h'],
        ['cape', 'J/kg'],
    ]) {
        const values = h[field];
        if (
            !Array.isArray(values) ||
            values.length !== h.time.length ||
            !values.every((v) => v === null || finite(v)) ||
            (units[field] !== unit && !(values.every((v) => v === null) && units[field] === 'undefined'))
        )
            return null;
    }
    const codes = h.weather_code as (number | null)[],
        gusts = h.wind_gusts_10m as (number | null)[],
        cape = h.cape as (number | null)[];
    if (utc(p.source_runs[0].data_end_at) < now + 23 * 3_600_000 || !Number.isFinite(utc(p.source_runs[0].data_end_at)))
        return null;
    const member: ConvectiveMember = {
        model,
        runAt,
        hours: h.time.map((at, i) => ({
            at: utc(at),
            code: codes[i],
            gustKts: gusts[i] === null ? null : gusts[i]! / 1.852,
            cape: cape[i],
            // Not in the current publisher contract. Missing LI/CIN remain unknown.
            liftedIndex: null,
            inhibition: null,
        })),
    };
    return freshConvectiveMembers([member], now).length ? member : null;
}
