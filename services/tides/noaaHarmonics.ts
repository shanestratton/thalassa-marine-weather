/** Informational station reconstruction, never a depth/clearance input.
 * Astronomy and satellite/nodal corrections adapted from UTide (MIT),
 * revision 9b60caf9aa5102b87935225a118275579e2f73b6. See UTIDE-LICENSE.txt.
 * Inputs: NOAA 9414290 harcon/datums, metric, Greenwich phase, epoch 1983–2001.
 * h = MSL-MLLW + sum[amplitude * f * cos(2π(V+u) - Greenwich lag)].
 * Exact-time lunar/solar arguments and latitude-dependent satellite factors
 * are evaluated at each sample, including compound-constituent corrections.
 * No tuning to the NOAA reference series, residual or weather correction.
 */
import raw from './noaaHarmonicData.json';
interface Node {
    doodson?: number[];
    semi?: number;
    satellites?: number[][];
    parents?: [string, number][];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteArray = (v: unknown, length: number): v is number[] =>
    Array.isArray(v) && v.length === length && v.every((n) => typeof n === 'number' && Number.isFinite(n));
function readNodes(value: unknown): Map<string, Node> | null {
    if (!record(value) || Object.keys(value).length > 100) return null;
    const result = new Map<string, Node>();
    for (const [name, row] of Object.entries(value)) {
        if (!record(row) || !/^[A-Z0-9]{1,8}$/.test(name)) return null;
        if (Array.isArray(row.parents)) {
            if (!row.parents.length || row.parents.length > 8) return null;
            const parents: [string, number][] = [];
            for (const p of row.parents) {
                if (
                    !Array.isArray(p) ||
                    p.length !== 2 ||
                    typeof p[0] !== 'string' ||
                    typeof p[1] !== 'number' ||
                    !Number.isFinite(p[1]) ||
                    Math.abs(p[1]) > 8
                )
                    return null;
                parents.push([p[0], p[1]]);
            }
            result.set(name, { parents });
        } else {
            if (
                !finiteArray(row.doodson, 6) ||
                typeof row.semi !== 'number' ||
                !Number.isFinite(row.semi) ||
                !Array.isArray(row.satellites) ||
                row.satellites.length > 30
            )
                return null;
            const satellites: number[][] = [];
            for (const satellite of row.satellites) {
                if (!finiteArray(satellite, 6) || ![0, 1, 2].includes(satellite[5])) return null;
                satellites.push(satellite);
            }
            result.set(name, { doodson: row.doodson, semi: row.semi, satellites });
        }
    }
    const complete = new Set<string>(),
        active = new Set<string>();
    const check = (name: string): boolean => {
        if (complete.has(name)) return true;
        if (active.has(name) || !result.has(name)) return false;
        active.add(name);
        if (result.get(name)!.parents?.some(([p]) => !check(p))) return false;
        active.delete(name);
        complete.add(name);
        return true;
    };
    return [...result.keys()].every(check) ? result : null;
}
const nodes = readNodes(raw.nodes);
function readConstituents(value: unknown): [string, number, number][] | null {
    if (!Array.isArray(value) || value.length !== 37) return null;
    const result: [string, number, number][] = [];
    const names = new Set<string>();
    for (const row of value) {
        if (
            !Array.isArray(row) ||
            row.length !== 3 ||
            typeof row[0] !== 'string' ||
            !nodes?.has(row[0]) ||
            names.has(row[0]) ||
            typeof row[1] !== 'number' ||
            !Number.isFinite(row[1]) ||
            row[1] < 0 ||
            row[1] > 20 ||
            typeof row[2] !== 'number' ||
            !Number.isFinite(row[2]) ||
            row[2] < 0 ||
            row[2] > 360
        )
            return null;
        names.add(row[0]);
        result.push([row[0], row[1], row[2]]);
    }
    return result;
}
const constituents = readConstituents(raw.constituents);
const TAU = 2 * Math.PI;
const MIN = Date.parse('2026-01-01T00:00:00Z'),
    MAX = Date.parse('2027-05-01T00:00:00Z');
export const NOAA_HARMONIC_STATION = {
    id: raw.stationId,
    name: raw.stationName,
    lat: raw.lat,
    lon: raw.lon,
    datum: raw.datum,
    datumEpoch: raw.datumEpoch,
    sourceUrl: 'https://tidesandcurrents.noaa.gov/harcon.html?id=9414290',
    constantsRetrieved: '2026-10-16',
    validFromMs: MIN,
    validUntilMs: MAX,
    comparison: { samples: 2184, maxErrorM: 0.043, periods: 'January 2026, 16 October–15 November 2026, April 2027' },
} as const;
/** UTide's astronomical epoch uses Python ordinal days (Unix epoch=719163).
 * Angles are cycles. This routine uses UTC instants and never device timezone. */
export function harmonicAstronomy(timeMs: number): number[] {
    const jd = timeMs / 86_400_000 + 719163,
        d = jd - 693595.5,
        D = d / 10000;
    const args = [1, d, D * D, D * D * D];
    const coefs = [
        [270.434164, 13.1763965268, -0.000085, 0.000000039],
        [279.696678, 0.9856473354, 0.00002267, 0],
        [334.329556, 0.1114040803, -0.0007739, -0.00000026],
        [-259.183275, 0.0529539222, -0.0001557, -0.00000005],
        [281.220844, 0.0000470684, 0.0000339, 0.00000007],
    ];
    const a = coefs.map((c) => (c.reduce((sum, x, i) => sum + x * args[i], 0) / 360) % 1);
    return [(jd % 1) + a[1] - a[0], ...a];
}
export function predictNoaaHarmonic(stationId: string, timeMs: number): number | null {
    if (
        !nodes ||
        !constituents ||
        stationId !== raw.stationId ||
        !Number.isFinite(timeMs) ||
        timeMs < MIN ||
        timeMs >= MAX
    )
        return null;
    const sourceNodes = nodes;
    const a = harmonicAstronomy(timeMs),
        slat = Math.sin((raw.lat * Math.PI) / 180);
    const memo = new Map<string, { f: number; u: number; v: number }>();
    const evaluate = (name: string): { f: number; u: number; v: number } => {
        const cached = memo.get(name);
        if (cached) return cached;
        const row = sourceNodes.get(name)!;
        let f = 1,
            u = 0,
            v = 0;
        if (row.parents) {
            for (const [parent, coefficient] of row.parents) {
                const p = evaluate(parent);
                f *= p.f ** Math.abs(coefficient);
                u += coefficient * p.u;
                v += coefficient * p.v;
            }
        } else {
            let real = 1,
                imag = 0;
            for (const [d1, d2, d3, correction, amplitude, latitudeFactor] of row.satellites ?? []) {
                let ratio = amplitude;
                if (latitudeFactor === 1) ratio *= (0.36309 * (1 - 5 * slat * slat)) / slat;
                if (latitudeFactor === 2) ratio *= 2.59808 * slat;
                const angle = TAU * (d1 * a[3] + d2 * a[4] + d3 * a[5] + correction);
                real += ratio * Math.cos(angle);
                imag += ratio * Math.sin(angle);
            }
            f = Math.hypot(real, imag);
            u = Math.atan2(imag, real) / TAU;
            v = row.doodson!.reduce((sum, x, i) => sum + x * a[i], row.semi!);
        }
        const result = { f, u, v };
        memo.set(name, result);
        return result;
    };
    let height = raw.meanM;
    for (const [name, amplitude, phase] of constituents) {
        const e = evaluate(name);
        height += amplitude * e.f * Math.cos(TAU * (e.v + e.u) - (phase * Math.PI) / 180);
    }
    return Number.isFinite(height) ? height : null;
}
/** Bounded hourly samples at the station, without an invented HW/LW timestamp. */
export function noaaHarmonicDay(stationId: string, day: string): { timeMs: number; heightM: number }[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const start = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) return [];
    const samples = [];
    for (let i = 0; i < 24; i++) {
        const timeMs = start + i * 3600000,
            heightM = predictNoaaHarmonic(stationId, timeMs);
        if (heightM === null) return [];
        samples.push({ timeMs, heightM });
    }
    return samples;
}
