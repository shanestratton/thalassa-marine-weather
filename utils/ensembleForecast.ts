/** Genuine single-model member statistics. No deterministic/mean-to-ensemble fallback. */
export const ENSEMBLE_PRODUCTS = {
    ifs: { model: 'ecmwf_ifs025_ensemble', label: 'ECMWF IFS ensemble', days: 15 },
    ec46: { model: 'ecmwf_ec46', label: 'ECMWF EC46', days: 46 },
} as const;
export type EnsembleProduct = keyof typeof ENSEMBLE_PRODUCTS;
export const ENSEMBLE_EXPECTED_MEMBERS = 51;
export const ENSEMBLE_MIN_MEMBERS = 41;
export const ENSEMBLE_THRESHOLD_KT = 25;
export interface EnsembleStatistic {
    count: number;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    exceeding: number | null;
}
export interface EnsembleHour {
    time: number;
    wind: EnsembleStatistic;
    gust: EnsembleStatistic;
}
export interface EnsembleForecast {
    schema: 1;
    product: EnsembleProduct;
    latitude: number;
    longitude: number;
    receivedAt: number;
    /** The ordinary member API does not supply a trustworthy run issue clock. */
    issuedAt: null;
    rawSha256: string;
    unit: 'kn';
    expectedMembers: 51;
    thresholdKt: 25;
    hours: EnsembleHour[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isEnsembleProduct = (v: unknown): v is EnsembleProduct => v === 'ifs' || v === 'ec46';
export function ensembleCoordinates(lat: unknown, lon: unknown): lat is number {
    return finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
/** R type-7 / linear interpolation at (n-1)p, applied to finite unique members. */
function statistic(values: number[]): EnsembleStatistic {
    const count = values.length;
    if (count < ENSEMBLE_MIN_MEMBERS) return { count, p10: null, p50: null, p90: null, exceeding: null };
    values.sort((a, b) => a - b);
    const q = (p: number) => {
        const index = (count - 1) * p;
        const low = Math.floor(index);
        return values[low] + (values[Math.ceil(index)] - values[low]) * (index - low);
    };
    return { count, p10: q(0.1), p50: q(0.5), p90: q(0.9), exceeding: values.filter((v) => v >= 25).length };
}
export function reduceEnsemble(
    value: unknown,
    product: EnsembleProduct,
    latitude: number,
    longitude: number,
    receivedAt: number,
    rawSha256: string,
): EnsembleForecast {
    const fail = (): never => {
        throw new Error('Ensemble member data unavailable');
    };
    if (
        !isEnsembleProduct(product) ||
        !ensembleCoordinates(latitude, longitude) ||
        !finite(receivedAt) ||
        !/^[a-f0-9]{64}$/.test(rawSha256)
    )
        fail();
    if (
        !record(value) ||
        !record(value.hourly) ||
        !record(value.hourly_units) ||
        value.utc_offset_seconds !== 0 ||
        !ensembleCoordinates(value.latitude, value.longitude)
    )
        return fail();
    const rad = Math.PI / 180;
    const distance =
        12742 *
        Math.asin(
            Math.min(
                1,
                Math.sqrt(
                    Math.sin(((value.latitude - latitude) * rad) / 2) ** 2 +
                        Math.cos(latitude * rad) *
                            Math.cos(value.latitude * rad) *
                            Math.sin((((value.longitude as number) - longitude) * rad) / 2) ** 2,
                ),
            ),
        );
    if (distance > 100 || Object.keys(value.hourly).length > 105) return fail();
    const block = value.hourly;
    const units = value.hourly_units;
    const times = block.time;
    if (!Array.isArray(times) || times.length < 2 || times.length > 1104 || units.time !== 'unixtime') return fail();
    const start = Math.floor(receivedAt / 86400000) * 86400000;
    if (
        times.some(
            (t, i) =>
                !finite(t) ||
                !Number.isSafeInteger(t) ||
                t * 1000 < start ||
                t * 1000 > start + ENSEMBLE_PRODUCTS[product].days * 86400000 ||
                (i > 0 && t - times[i - 1] < 3600),
        )
    )
        return fail();
    const read = (variable: string) => {
        const members = new Map<number, (number | null)[]>();
        for (const [key, array] of Object.entries(block)) {
            if (key !== variable && !key.startsWith(`${variable}_member`)) continue;
            const suffix = key.slice(variable.length);
            if (suffix && !/^_member\d{2}$/.test(suffix)) return fail();
            const id = suffix ? Number(suffix.slice(7)) : 0;
            if (
                id > 50 ||
                members.has(id) ||
                units[key] !== 'kn' ||
                !Array.isArray(array) ||
                array.length !== times.length ||
                array.some((v) => v !== null && (!finite(v) || v < 0 || v > 250))
            )
                return fail();
            members.set(id, array);
        }
        // An unsuffixed deterministic run (or mean) alone is never an ensemble.
        if (members.size < 2) return [];
        return [...members.values()];
    };
    const wind = read('wind_speed_10m');
    const gust = read('wind_gusts_10m');
    if (!wind.length && !gust.length) return fail();
    return {
        schema: 1,
        product,
        latitude,
        longitude,
        receivedAt,
        issuedAt: null,
        rawSha256,
        unit: 'kn',
        expectedMembers: 51,
        thresholdKt: 25,
        hours: times.map((time, i) => ({
            time: time * 1000,
            wind: statistic(wind.flatMap((m) => (m[i] === null ? [] : [m[i]]))),
            gust: statistic(gust.flatMap((m) => (m[i] === null ? [] : [m[i]]))),
        })),
    };
}
/** Validate the reduced network boundary again before drawing any band. */
export function parseEnsembleForecast(
    value: unknown,
    product: EnsembleProduct,
    lat: number,
    lon: number,
    now: number,
): EnsembleForecast | null {
    if (
        !record(value) ||
        value.schema !== 1 ||
        value.product !== product ||
        value.latitude !== lat ||
        value.longitude !== lon ||
        value.unit !== 'kn' ||
        value.expectedMembers !== 51 ||
        value.thresholdKt !== 25 ||
        value.issuedAt !== null ||
        !finite(value.receivedAt) ||
        value.receivedAt > now + 60000 ||
        now - value.receivedAt > 1800000 ||
        typeof value.rawSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.rawSha256) ||
        !Array.isArray(value.hours) ||
        value.hours.length < 2 ||
        value.hours.length > 1104
    )
        return null;
    const check = (s: unknown) => {
        if (!record(s) || !Number.isInteger(s.count) || (s.count as number) < 0 || (s.count as number) > 51)
            return false;
        if ((s.count as number) < 41) return s.p10 === null && s.p50 === null && s.p90 === null && s.exceeding === null;
        return (
            [s.p10, s.p50, s.p90].every((n) => finite(n) && n >= 0 && n <= 250) &&
            (s.p10 as number) <= (s.p50 as number) &&
            (s.p50 as number) <= (s.p90 as number) &&
            Number.isInteger(s.exceeding) &&
            (s.exceeding as number) >= 0 &&
            (s.exceeding as number) <= (s.count as number)
        );
    };
    const start = Math.floor(value.receivedAt / 86400000) * 86400000;
    if (
        value.hours.some(
            (h, i, rows) =>
                !record(h) ||
                !finite(h.time) ||
                h.time < start ||
                h.time > start + ENSEMBLE_PRODUCTS[product].days * 86400000 ||
                (i > 0 && h.time <= rows[i - 1].time) ||
                !check(h.wind) ||
                !check(h.gust),
        )
    )
        return null;
    return value as unknown as EnsembleForecast;
}
