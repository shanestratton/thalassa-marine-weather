import { runOffshoreHosted, type OffshoreHostOptions } from './offshoreWorkerHost';
import { offshoreWindFields } from './offshoreJob';
import type { OffshoreJob, OffshoreCandidate } from './offshoreProtocol';
import type { WindGrid } from '../weather/windGridEncoding';
import type { Feature, LineString } from 'geojson';

/** These are global domains. UKV is display-only and is deliberately absent. */
export const OFFSHORE_COMPARISON_MODELS = [
    { id: 'ecmwf', label: 'ECMWF', domain: 'ecmwf_ifs', credit: 'ECMWF via Open-Meteo · CC BY 4.0', colour: '#38bdf8' },
    { id: 'gfs', label: 'GFS', domain: 'gfs_global', credit: 'NOAA via Open-Meteo · public domain', colour: '#fbbf24' },
    { id: 'icon', label: 'ICON', domain: 'dwd_icon', credit: 'DWD via Open-Meteo · CC BY 4.0', colour: '#a78bfa' },
    {
        id: 'gem',
        label: 'GEM',
        domain: 'gem_global',
        credit: 'ECCC via Open-Meteo · ECCC Data Services licence',
        colour: '#fb923c',
    },
] as const;
export type OffshoreComparisonModel = (typeof OFFSHORE_COMPARISON_MODELS)[number];
export interface OffshoreComparisonRow {
    model: OffshoreComparisonModel;
    status: 'loading' | 'unavailable' | 'failed' | 'candidate';
    candidate?: OffshoreCandidate;
    message?: string;
}
type Bounds = { north: number; south: number; west: number; east: number };
const memo = new Map<string, { grid: WindGrid; at: number; bytes: number }>();
const TTL = 30 * 60_000,
    MAX_BYTES = 32 * 1024 * 1024;
const gridBytes = (grid: WindGrid) =>
    [grid.u, grid.v, grid.speed, grid.gust ?? []].flat().reduce((n, frame) => n + frame.byteLength, 0);

function remember(key: string, grid: WindGrid): void {
    const bytes = gridBytes(grid);
    if (bytes > MAX_BYTES) return;
    memo.delete(key);
    for (const [k, value] of memo) if (Date.now() - value.at >= TTL) memo.delete(k);
    while (memo.size >= 4 || [...memo.values()].reduce((n, value) => n + value.bytes, 0) + bytes > MAX_BYTES)
        memo.delete(memo.keys().next().value!);
    memo.set(key, { grid, at: Date.now(), bytes });
}

export interface OffshoreComparisonOptions extends OffshoreHostOptions {
    base: Omit<OffshoreJob, 'wind' | 'deadlineMs'>;
    bounds: Bounds;
    /** Must reflect a confirmed commercial capability; each model still needs finite data at runtime. */
    commercialEnabled: boolean;
    /** Includes the caller's environment/bathymetry preparation in the same total budget. */
    deadlineMs?: number;
    onRow?: (row: OffshoreComparisonRow) => void;
    onGrid?: (model: OffshoreComparisonModel, grid: WindGrid) => void;
    loadGrid?: (model: OffshoreComparisonModel, bounds: Bounds) => Promise<WindGrid | null>;
    run?: (job: OffshoreJob, opts: OffshoreHostOptions) => Promise<OffshoreCandidate | null>;
}

/** A 60-second total budget, at most two Workers, and four public forecast grids held for at most 30 minutes. */
export async function compareOffshoreModels(opts: OffshoreComparisonOptions): Promise<OffshoreComparisonRow[]> {
    const deadlineMs = Math.min(Date.now() + 60_000, opts.deadlineMs ?? Infinity);
    for (const [key, entry] of memo) if (Date.now() - entry.at >= TTL) memo.delete(key);
    const live = () => !opts.signal?.aborted && (opts.isCurrent?.() ?? true) && Date.now() < deadlineMs;
    const rows = OFFSHORE_COMPARISON_MODELS.map((model) => ({
        model,
        status: 'loading' as const,
    })) as OffshoreComparisonRow[];
    const publish = (index: number, row: OffshoreComparisonRow) => {
        rows[index] = row;
        if (live()) opts.onRow?.(row);
    };
    if (!opts.commercialEnabled)
        return rows.map((row) => ({
            ...row,
            status: 'unavailable',
            message: 'Commercial model capability is not confirmed.',
        }));
    const load =
        opts.loadGrid ??
        (async (model, bounds) => {
            const { fetchModelWindGrid } = await import('../weather/OpenMeteoWindFetcher');
            return fetchModelWindGrid(model.id, bounds, 168, 2, model.domain, network.signal);
        });
    const network = new AbortController();
    const cancelNetwork = () => network.abort();
    opts.signal?.addEventListener('abort', cancelNetwork, { once: true });
    if (opts.signal?.aborted) network.abort();
    const budgetTimer = setTimeout(cancelNetwork, Math.max(1, deadlineMs - Date.now()));
    const staleNetwork = setInterval(() => {
        if (!live()) network.abort();
    }, 100);
    let next = 0;
    let retainedBytes = 0;
    const lane = async () => {
        while (live()) {
            const index = next++;
            if (index >= rows.length) return;
            const model = rows[index].model;
            publish(index, { model, status: 'loading' });
            const key = JSON.stringify([model.domain, opts.bounds]);
            try {
                const cached = memo.get(key);
                const pending =
                    cached && Date.now() - cached.at < TTL ? Promise.resolve(cached.grid) : load(model, opts.bounds);
                let timer: ReturnType<typeof setTimeout> | undefined;
                let staleTimer: ReturnType<typeof setInterval> | undefined;
                const grid = await Promise.race([
                    pending,
                    new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), Math.max(1, deadlineMs - Date.now()));
                        staleTimer = setInterval(() => {
                            if (!live()) resolve(null);
                        }, 100);
                    }),
                ]).finally(() => {
                    clearTimeout(timer);
                    clearInterval(staleTimer);
                });
                if (!live()) return;
                if (!grid) {
                    publish(index, { model, status: 'unavailable', message: 'Model forecast unavailable.' });
                    continue;
                }
                const bytes = gridBytes(grid);
                if (retainedBytes + bytes > MAX_BYTES) {
                    publish(index, {
                        model,
                        status: 'unavailable',
                        message: 'Model grids exceeded the comparison memory limit.',
                    });
                    continue;
                }
                const job = { ...opts.base, wind: grid, deadlineMs };
                const fields = offshoreWindFields(job);
                const probes = [job.origin, job.destination];
                if (
                    probes.some((point) => {
                        const w = fields.wind.getWind(point.lat, point.lon, 0);
                        return !w || !(w.speed > 0);
                    })
                ) {
                    publish(index, {
                        model,
                        status: 'unavailable',
                        message: 'Model did not provide finite wind for this departure.',
                    });
                    continue;
                }
                remember(key, grid);
                retainedBytes += bytes;
                opts.onGrid?.(model, grid);
                const candidate = await (opts.run ?? runOffshoreHosted)(job, {
                    signal: opts.signal,
                    isCurrent: live,
                    onProgress: opts.onProgress,
                });
                if (!live()) return;
                publish(
                    index,
                    candidate
                        ? { model, status: 'candidate', candidate }
                        : {
                              model,
                              status: 'unavailable',
                              message: 'No modeled route with forecast coverage was found.',
                          },
                );
            } catch (error) {
                if (!live()) return;
                publish(index, {
                    model,
                    status: 'failed',
                    message: error instanceof Error ? error.message : 'Model comparison failed.',
                });
            }
        }
    };
    try {
        await Promise.all([lane(), lane()]);
    } finally {
        clearTimeout(budgetTimer);
        clearInterval(staleNetwork);
        opts.signal?.removeEventListener('abort', cancelNetwork);
        network.abort();
    }
    return rows.map((row) =>
        row.status === 'loading'
            ? { ...row, status: 'unavailable', message: 'Comparison stopped or exceeded its time budget.' }
            : row,
    );
}

/** Forecast spread only. A candidate line remains unselectable until the page's chart/land verifier accepts it. */
export function offshoreComparisonSummary(rows: readonly OffshoreComparisonRow[]) {
    const successful = rows.filter((row) => row.status === 'candidate' && row.candidate);
    if (successful.length < 2) return null;
    const durations = successful.map((row) => row.candidate!.result.totalDurationHours);
    return {
        modelCount: successful.length,
        models: successful.map((row) => row.model.label),
        etaSpreadHours: Math.max(...durations) - Math.min(...durations),
        credits: successful.map((row) => row.model.credit),
    };
}
export function offshoreComparisonLine(row: OffshoreComparisonRow): Feature<LineString> | null {
    if (row.status !== 'candidate' || !row.candidate) return null;
    // Draw the short crossing of 180 degrees; keep the candidate's original coordinates for verification.
    const coordinates: [number, number][] = [];
    for (const [lon, lat] of row.candidate.result.routeCoordinates) {
        const previous = coordinates.at(-1)?.[0];
        coordinates.push([previous === undefined ? lon : lon + Math.round((previous - lon) / 360) * 360, lat]);
    }
    return {
        type: 'Feature',
        properties: {
            model: row.model.id,
            colour: row.model.colour,
            verification: 'unverified-public-data',
            selectable: false,
        },
        geometry: { type: 'LineString', coordinates },
    };
}
export function clearOffshoreComparisonMemo(): void {
    memo.clear();
}
