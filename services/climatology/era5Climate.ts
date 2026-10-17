/** 1991–2020 hourly reanalysis distributions. Never a forecast or routing input. */
export const CLIMATE_YEARS = [1991, 2020] as const;
export const CLIMATE_WIND_BINS = [0, 5, 10, 15, 20, 25, 34, 48] as const;
export const CLIMATE_WAVE_BINS = [0, 0.5, 1, 2, 3, 4, 6, 9] as const;
export const CLIMATE_FULL_YEARS = 2 ** 30 - 1;
export const CLIMATE_LIMITS = { cells: 128, samples: 8192, tiles: 32, tileBytes: 524288, totalBytes: 8388608 } as const;
export interface ClimateMonth {
    windCount: number;
    waveCount: number;
    windCalm: number;
    waveCalm: number;
    galeCount: number;
    highWaveCount: number;
    /** Bit0=1991, bit29=2020; a year counts only with >=90% of its original hours. */
    windYears: number;
    waveYears: number;
    /** 16 from-directions clockwise from north × eight magnitude bins. */
    windRose: number[];
    waveRose: number[];
}
export interface ClimateCell {
    key: string;
    months: ClimateMonth[];
}
export interface ClimateRouteMonth {
    windRose: number[];
    waveRose: number[];
    windCalm: number;
    waveCalm: number;
    gales: number;
    highWaves: number;
    coveredNm: number;
    totalNm: number;
    complete: boolean;
}
export interface ClimatePoint {
    lat: number;
    lon: number;
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, max: number): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
export const climateCellKey = (lat: number, lon: number) =>
    `${Math.round(lat)},${((Math.round(lon) + 540) % 360) - 180}`;
export function climateTileKey(cell: string): string {
    const [lat, lon] = cell.split(',').map(Number);
    if (
        !Number.isInteger(lat) ||
        Math.abs(lat) > 90 ||
        !Number.isInteger(lon) ||
        lon < -180 ||
        lon >= 180 ||
        climateCellKey(lat, lon) !== cell
    )
        throw new Error('Invalid climate cell');
    return `${Math.floor((lat + 90) / 5)}_${Math.floor((lon + 180) / 5)}`;
}
export function climateExpectedHours(month: number): number {
    let hours = 0;
    for (let year = 1991; year <= 2020; year++) hours += new Date(Date.UTC(year, month + 1, 0)).getUTCDate() * 24;
    return hours;
}
export function parseClimateCell(value: unknown): ClimateCell | null {
    if (!isRecord(value) || typeof value.key !== 'string' || !Array.isArray(value.months) || value.months.length !== 12)
        return null;
    try {
        climateTileKey(value.key);
    } catch {
        return null;
    }
    for (const [month, row] of value.months.entries()) {
        if (!isRecord(row)) return null;
        const max = climateExpectedHours(month);
        if (
            !['windCount', 'waveCount', 'windCalm', 'waveCalm', 'galeCount', 'highWaveCount'].every((k) =>
                integer(row[k], max),
            ) ||
            !integer(row.windYears, CLIMATE_FULL_YEARS) ||
            !integer(row.waveYears, CLIMATE_FULL_YEARS)
        )
            return null;
        if (
            (row.galeCount as number) > (row.windCount as number) ||
            (row.highWaveCount as number) > (row.waveCount as number)
        )
            return null;
        for (const kind of ['wind', 'wave'] as const) {
            const bins = row[`${kind}Rose`];
            if (
                !Array.isArray(bins) ||
                bins.length !== 128 ||
                bins.some((n) => !integer(n, max)) ||
                bins.reduce((a, b) => a + b, 0) + (row[`${kind}Calm`] as number) !== row[`${kind}Count`]
            )
                return null;
            if (row[`${kind}Years`] === CLIMATE_FULL_YEARS && (row[`${kind}Count`] as number) < 0.9 * max) return null;
        }
        if (
            (row.windRose as number[]).reduce((sum, n, i) => sum + (i % 8 >= 6 ? n : 0), 0) !== row.galeCount ||
            (row.waveRose as number[]).reduce((sum, n, i) => sum + (i % 8 >= 4 ? n : 0), 0) !== row.highWaveCount
        )
            return null;
    }
    return value as unknown as ClimateCell;
}
/** Midpoint length weights on bounded short great-circle segments, including the dateline. */
export function climateRouteWeights(legs: readonly { points: readonly ClimatePoint[] }[]): Map<string, number> {
    if (!legs.length || legs.length > 100) throw new Error('Route climate leg limit');
    const weights = new Map<string, number>();
    let samples = 0;
    const rad = Math.PI / 180;
    for (const { points } of legs) {
        if (points.length < 2 || points.length > 4096) throw new Error('Route climate geometry unavailable');
        if (
            points.some(
                (p) =>
                    !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180,
            )
        )
            throw new Error('Invalid route climate geometry');
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1],
                b = points[i];
            const u = [
                Math.cos(a.lat * rad) * Math.cos(a.lon * rad),
                Math.cos(a.lat * rad) * Math.sin(a.lon * rad),
                Math.sin(a.lat * rad),
            ];
            const v = [
                Math.cos(b.lat * rad) * Math.cos(b.lon * rad),
                Math.cos(b.lat * rad) * Math.sin(b.lon * rad),
                Math.sin(b.lat * rad),
            ];
            const angle = Math.acos(
                Math.max(
                    -1,
                    Math.min(
                        1,
                        u.reduce((s, n, k) => s + n * v[k], 0),
                    ),
                ),
            );
            if (angle < 1e-9) continue;
            if (angle > Math.PI - 1e-6) throw new Error('Ambiguous route climate geometry');
            const nm = angle * 3440.065;
            const count = Math.ceil(nm / 20);
            samples += count;
            if (samples > CLIMATE_LIMITS.samples) throw new Error('Route climate sampling limit');
            for (let j = 0; j < count; j++) {
                const fraction = (j + 0.5) / count;
                const x = Math.sin((1 - fraction) * angle) / Math.sin(angle),
                    y = Math.sin(fraction * angle) / Math.sin(angle);
                const p = u.map((n, k) => x * n + y * v[k]);
                const key = climateCellKey(
                    Math.atan2(p[2], Math.hypot(p[0], p[1])) / rad,
                    Math.atan2(p[1], p[0]) / rad,
                );
                weights.set(key, (weights.get(key) ?? 0) + nm / count);
                if (weights.size > CLIMATE_LIMITS.cells) throw new Error('Route climate coverage limit');
            }
        }
    }
    if (!weights.size) throw new Error('No route length to assess');
    return weights;
}
/** Spatial length-weighted frequencies, not independent samples pooled across correlated cells. */
export function assessEra5Climate(
    weights: ReadonlyMap<string, number>,
    cells: ReadonlyMap<string, ClimateCell>,
): ClimateRouteMonth[] {
    const totalNm = [...weights.values()].reduce((a, b) => a + b, 0);
    return Array.from({ length: 12 }, (_, month) => {
        const result: ClimateRouteMonth = {
            windRose: Array(128).fill(0),
            waveRose: Array(128).fill(0),
            windCalm: 0,
            waveCalm: 0,
            gales: 0,
            highWaves: 0,
            coveredNm: 0,
            totalNm,
            complete: false,
        };
        for (const [key, nm] of weights) {
            const row = cells.get(key)?.months[month];
            if (
                !row ||
                row.windYears !== CLIMATE_FULL_YEARS ||
                row.waveYears !== CLIMATE_FULL_YEARS ||
                !row.windCount ||
                !row.waveCount
            )
                continue;
            result.coveredNm += nm;
            result.gales += (nm * row.galeCount) / row.windCount;
            result.highWaves += (nm * row.highWaveCount) / row.waveCount;
            result.windCalm += (nm * row.windCalm) / row.windCount;
            result.waveCalm += (nm * row.waveCalm) / row.waveCount;
            for (let i = 0; i < 128; i++) {
                result.windRose[i] += (nm * row.windRose[i]) / row.windCount;
                result.waveRose[i] += (nm * row.waveRose[i]) / row.waveCount;
            }
        }
        if (result.coveredNm > 0) {
            for (const key of ['gales', 'highWaves', 'windCalm', 'waveCalm'] as const) result[key] /= result.coveredNm;
            result.windRose = result.windRose.map((n) => n / result.coveredNm);
            result.waveRose = result.waveRose.map((n) => n / result.coveredNm);
        }
        result.complete = totalNm > 0 && result.coveredNm >= totalNm * (1 - 1e-10);
        return result;
    });
}
export function lowerExposureMonths(months: readonly ClimateRouteMonth[]): number[] {
    // A partial route is never promoted to a best-month claim.
    return months
        .map((value, month) => ({ value, month }))
        .filter(({ value }) => value.complete)
        .sort((a, b) => a.value.gales - b.value.gales || a.value.highWaves - b.value.highWaves || a.month - b.month)
        .slice(0, 3)
        .map(({ month }) => month);
}
