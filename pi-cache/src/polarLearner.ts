import type { TrackStore } from './trackStore.js';
import {
    polarPeriodAt,
    polarSailingGate,
    validPolarTable,
    type PolarObservation,
    type PolarTable,
    type PolarPeriod,
} from './polarLearningRule.js';

interface Bucket {
    sum: number;
    sum2: number;
    count: number;
}
interface LearnerState {
    version: 1;
    enabled: boolean;
    configured: boolean;
    cursor: number;
    updatedAt: number;
    baseline: PolarTable | null;
    previous: PolarObservation | null;
    steadySince: number | null;
    lastSampleAt: number;
    engineRunning: boolean;
    rejected: number;
    samples: Record<PolarPeriod, number>;
    grids: Record<PolarPeriod, Record<string, Bucket>>;
}
const empty = (): LearnerState => ({
    version: 1,
    enabled: false,
    configured: false,
    cursor: 0,
    updatedAt: 0,
    baseline: null,
    previous: null,
    steadySince: null,
    lastSampleAt: 0,
    engineRunning: false,
    rejected: 0,
    samples: { all: 0, day: 0, night: 0 },
    grids: { all: {}, day: {}, night: {} },
});
const number = (row: Record<string, unknown>, key: string): number | null =>
    typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : null;
function observation(row: Record<string, unknown>): PolarObservation | null {
    const values = ['at_ms', 'lat', 'lon', 'tws_kts', 'twa_deg', 'stw_kts', 'sog_kts', 'hdg_deg'].map((key) =>
        number(row, key),
    );
    if (values.some((v) => v === null)) return null;
    const [at, lat, lon, tws, twa, stw, sog, heading] = values as number[];
    return { at, lat, lon, tws, twa, stw, sog, heading, rpm: number(row, 'engine_rpm') };
}

/** Bounded batches and an atomic aggregate/cursor checkpoint; no history replay on reboot. */
export class PiPolarLearner {
    private state = empty();
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(
        private readonly store: Pick<
            TrackStore,
            'polarPointsAfter' | 'polarLastRowId' | 'readPolarState' | 'writePolarState' | 'isEnabled'
        >,
    ) {
        try {
            const raw = this.store.readPolarState();
            const saved = raw && raw.length <= 1048576 ? (JSON.parse(raw) as LearnerState) : null;
            if (
                saved?.version === 1 &&
                Number.isSafeInteger(saved.cursor) &&
                saved.cursor >= 0 &&
                typeof saved.enabled === 'boolean' &&
                typeof saved.configured === 'boolean' &&
                typeof saved.engineRunning === 'boolean' &&
                Number.isFinite(saved.updatedAt) &&
                Number.isFinite(saved.lastSampleAt) &&
                saved.grids &&
                ['all', 'day', 'night'].every((p) => {
                    const grid = saved.grids[p as PolarPeriod];
                    return (
                        grid &&
                        Object.keys(grid).length <= 465 &&
                        Object.entries(grid).every(
                            ([key, b]) =>
                                /^tws_\d{1,2}_twa_\d{2,3}$/.test(key) &&
                                Number.isSafeInteger(b.count) &&
                                b.count > 0 &&
                                Number.isFinite(b.sum) &&
                                b.sum >= 0 &&
                                Number.isFinite(b.sum2) &&
                                b.sum2 >= 0,
                        ) &&
                        Number.isSafeInteger(saved.samples?.[p as PolarPeriod]) &&
                        saved.samples[p as PolarPeriod] >= 0
                    );
                }) &&
                (saved.baseline === null || validPolarTable(saved.baseline))
            )
                this.state = saved;
        } catch {
            /* Unreadable learner state cannot take down the vessel recorder. */
        }
    }
    start(): void {
        if (this.timer) return;
        const tick = () => {
            try {
                this.processBatch();
            } catch {
                /* Retry the same uncommitted batch next tick. */
            }
        };
        this.timer = setInterval(tick, 15000);
        this.timer.unref?.();
        tick();
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
    configure(input: { enabled: boolean; baseline?: PolarTable }): void {
        if (typeof input.enabled !== 'boolean' || (input.baseline !== undefined && !validPolarTable(input.baseline)))
            throw new Error('Invalid polar learner settings');
        const next = structuredClone(this.state);
        if (!input.enabled || (next.configured && !next.enabled)) next.cursor = this.store.polarLastRowId();
        next.enabled = input.enabled;
        next.configured = true;
        next.previous = null;
        next.steadySince = null;
        if (input.baseline) next.baseline = structuredClone(input.baseline);
        this.store.writePolarState(JSON.stringify(next));
        this.state = next;
    }
    processBatch(): number {
        if (!this.state.enabled) return 0;
        const rows = this.store.polarPointsAfter(this.state.cursor, 500);
        if (rows.length === 0) return 0;
        const next = structuredClone(this.state);
        for (const row of rows) {
            const id = number(row, 'sample_id');
            if (id === null || !Number.isSafeInteger(id) || id <= next.cursor)
                throw new Error('Invalid history cursor');
            next.cursor = id;
            const sample = observation(row);
            const previous = next.previous;
            const rpm = number(row, 'engine_rpm');
            if (rpm !== null) next.engineRunning = rpm > 0;
            const passes = sample !== null && !next.engineRunning && polarSailingGate(sample, previous, next.baseline);
            next.previous = sample;
            if (!passes || !sample) {
                next.steadySince = null;
                next.rejected++;
                continue;
            }
            next.steadySince ??= previous?.at ?? sample.at;
            // A settled minute, then at most one independent sample every 30 seconds.
            if (sample.at - next.steadySince < 60000 || sample.at - next.lastSampleAt < 30000) continue;
            const key = `tws_${Math.floor(sample.tws / 2) * 2}_twa_${Math.floor(sample.twa / 5) * 5}`;
            const total = next.grids.all[key];
            if (total && total.count >= 10) {
                const mean = total.sum / total.count;
                const spread = Math.max(0.1, Math.sqrt(Math.max(0, total.sum2 / total.count - mean * mean)));
                if (Math.abs(sample.stw - mean) > 3 * spread) {
                    next.rejected++;
                    continue;
                }
            }
            const period = polarPeriodAt(sample.at, sample.lat, sample.lon);
            for (const variant of ['all', period] as const) {
                const bucket = (next.grids[variant][key] ??= { sum: 0, sum2: 0, count: 0 });
                bucket.sum += sample.stw;
                bucket.sum2 += sample.stw * sample.stw;
                bucket.count++;
                next.samples[variant]++;
            }
            next.lastSampleAt = sample.at;
            next.updatedAt = sample.at;
        }
        this.store.writePolarState(JSON.stringify(next));
        this.state = next;
        return rows.length;
    }
    snapshot(): {
        version: 1;
        enabled: boolean;
        trackRecording: boolean;
        updatedAt: number;
        processedRowId: number;
        samples: Record<PolarPeriod, number>;
        rejected: number;
        polars: Record<PolarPeriod, PolarTable | null>;
        extendedPolars: Record<PolarPeriod, PolarTable | null>;
    } {
        const table = (period: PolarPeriod): PolarTable | null => {
            const windSpeeds = [6, 8, 10, 12, 15, 20, 25],
                angles = [30, 35, 40, 45, 60, 90, 120, 150, 180];
            const matrix = angles.map((angle) =>
                windSpeeds.map((tws) => {
                    let weight = 0,
                        sum = 0;
                    const centre = Math.floor(tws / 2) * 2;
                    for (const dw of [-2, 0, 2])
                        for (const da of [-5, 0, 5]) {
                            const b = this.state.grids[period][`tws_${centre + dw}_twa_${angle + da}`];
                            if (!b || b.count < 10) continue;
                            const w = b.count / (Math.hypot(dw / 2, da / 5) + 0.1);
                            sum += (b.sum / b.count) * w;
                            weight += w;
                        }
                    return weight ? Math.round((sum / weight) * 10) / 10 : 0;
                }),
            );
            return matrix.flat().some((v) => v > 0) ? { windSpeeds, angles, matrix } : null;
        };
        const extendedPolars = { all: table('all'), day: table('day'), night: table('night') };
        const legacy = (p: PolarTable | null): PolarTable | null =>
            p ? { windSpeeds: p.windSpeeds, angles: p.angles.slice(3), matrix: p.matrix.slice(3) } : null;
        return {
            version: 1,
            enabled: this.state.enabled,
            trackRecording: this.store.isEnabled(),
            updatedAt: this.state.updatedAt,
            processedRowId: this.state.cursor,
            samples: { ...this.state.samples },
            rejected: this.state.rejected,
            // Build133's strict reader retains its original axes. New clients use the optional extension.
            polars: {
                all: legacy(extendedPolars.all),
                day: legacy(extendedPolars.day),
                night: legacy(extendedPolars.night),
            },
            extendedPolars,
        };
    }
}
