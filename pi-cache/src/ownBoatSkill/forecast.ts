import { createHash } from 'node:crypto';
import {
    OWN_BOAT_MODELS,
    OWN_BOAT_SKILL,
    ownBoatClock,
    ownBoatRecord,
    type OwnBoatModel,
} from '../ownBoatSkillWire.js';
export interface CapturedWindForecast {
    model: OwnBoatModel;
    cell: string;
    runAt: number;
    capturedAt: number;
    sha256: string;
    raw: Buffer;
    points: readonly (readonly [number, number])[];
}
/** Derived only when original bytes and the admission metadata proof still match. */
export type VerifiedWindIssue = Omit<CapturedWindForecast, 'raw'>;
const DOMAINS: Record<OwnBoatModel, readonly string[]> = {
    ecmwf_ifs025: ['ecmwf_ifs025'],
    ecmwf_aifs025_single: ['ecmwf_aifs025_single'],
    dwd_icon: ['dwd_icon'],
    ukmo_global_deterministic_10km: ['ukmo_global_deterministic_10km'],
    jma_gsm: ['jma_gsm'],
    gfs_seamless: ['ncep_gfs013', 'ncep_gfs025'],
};
const HOUR = 3_600_000;
const utc = (value: unknown): number => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(value)) return NaN;
    const at = Date.parse(value);
    return ownBoatClock(at) && new Date(at).toISOString().slice(0, 10) === value.slice(0, 10) ? at : NaN;
};
/** Own wx2 coarse-cell original only. This intentionally does not project weather or import SunCalc. */
export function decodeOwnWindForecast(
    raw: Buffer,
    model: OwnBoatModel,
    cell: string,
    capturedAt: number,
): CapturedWindForecast | null {
    if (
        !OWN_BOAT_MODELS.includes(model) ||
        raw.length < 2 ||
        raw.length > OWN_BOAT_SKILL.forecastBytes ||
        !ownBoatClock(capturedAt) ||
        !/^-?\d{1,4}_-?\d{1,5}$/.test(cell)
    )
        return null;
    let rows: unknown;
    try {
        rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
        return null;
    }
    if (!Array.isArray(rows) || rows.length !== 1 || !ownBoatRecord(rows[0])) return null;
    const row = rows[0],
        payload = row.payload;
    if (!ownBoatRecord(payload) || !ownBoatRecord(payload.thalassa_provenance) || typeof row.run_at !== 'string')
        return null;
    const p = payload.thalassa_provenance,
        runAt = utc(row.run_at.replace(/\+00:00$/, 'Z'));
    const [south, west] = cell.split('_').map(Number),
        lat = south / 100 + 0.125,
        lon = west / 100 + 0.125;
    if (
        south < -9000 ||
        south >= 9000 ||
        west < -18000 ||
        west >= 18000 ||
        south % 25 ||
        west % 25 ||
        !Number.isFinite(runAt) ||
        runAt % (3 * HOUR) ||
        capturedAt - runAt < 20 * 60_000 ||
        capturedAt - runAt > 24 * HOUR ||
        p.version !== 2 ||
        p.source !== 'wx' ||
        p.model !== model ||
        utc(p.run_at) !== runAt ||
        p.cell_id !== cell ||
        p.cell_selection !== 'sea' ||
        p.sampling !== 'cell-centre' ||
        p.cell_degrees !== 0.25 ||
        p.latitude !== lat ||
        p.longitude !== lon ||
        payload.utc_offset_seconds !== 0 ||
        !['UTC', 'GMT', 'Etc/UTC'].includes(String(payload.timezone)) ||
        typeof payload.latitude !== 'number' ||
        !Number.isFinite(payload.latitude) ||
        Math.abs(payload.latitude) > 90 ||
        Math.abs(payload.latitude - lat) > 1 ||
        typeof payload.longitude !== 'number' ||
        !Number.isFinite(payload.longitude) ||
        Math.abs(payload.longitude) > 180 ||
        Math.abs(((payload.longitude - lon + 540) % 360) - 180) > 1 ||
        JSON.stringify(p.source_domains) !== JSON.stringify(DOMAINS[model]) ||
        !Array.isArray(p.source_runs) ||
        p.source_runs.length !== DOMAINS[model].length
    )
        return null;
    // Mixed seamless runs have no defensible per-valid-hour issuer: leave GFS unscored.
    for (const [i, source] of p.source_runs.entries()) {
        if (
            !ownBoatRecord(source) ||
            source.domain !== DOMAINS[model][i] ||
            utc(source.run_at) !== runAt ||
            !Number.isFinite(utc(source.data_end_at)) ||
            utc(source.data_end_at) < capturedAt + 23 * HOUR
        )
            return null;
    }
    if (
        !ownBoatRecord(payload.hourly) ||
        !ownBoatRecord(payload.hourly_units) ||
        payload.hourly_units.time !== 'iso8601' ||
        payload.hourly_units.wind_speed_10m !== 'km/h'
    )
        return null;
    const { time, wind_speed_10m: speeds } = payload.hourly;
    if (
        !Array.isArray(time) ||
        time.length < 24 ||
        time.length > 384 ||
        !Array.isArray(speeds) ||
        speeds.length !== time.length
    )
        return null;
    const times = time.map(utc);
    if (
        !times.every((at, i) => Number.isFinite(at) && at % HOUR === 0 && (!i || at - times[i - 1] === HOUR)) ||
        times.at(-1)! > capturedAt + 16 * 24 * HOUR ||
        !speeds.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600))
    )
        return null;
    const index = times.indexOf(Math.floor(capturedAt / HOUR) * HOUR);
    if (
        index < 0 ||
        index + 24 > times.length ||
        !speeds.slice(index, index + 24).every((v) => typeof v === 'number' && Number.isFinite(v))
    )
        return null;
    const points: [number, number][] = [];
    for (let i = 0; i < times.length; i++)
        if (times[i] > capturedAt && times[i] - runAt <= 72 * HOUR && speeds[i] !== null)
            points.push([times[i], speeds[i] / 3.6]);
    if (!points.length || points.length > 73) return null;
    return {
        model,
        cell,
        runAt,
        capturedAt,
        sha256: createHash('sha256').update(raw).digest('hex'),
        raw: Buffer.from(raw),
        points,
    };
}
