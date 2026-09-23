/** Advisory passage ETA: bounded observed boat-speed history, never a navigation command. */
import { calculateDistance } from '../utils/navigationCalculations';
export const PASSAGE_ETA_POLL_MS = 15_000;
export const PASSAGE_ETA_REFRESH_MS = 60_000;
export const PASSAGE_ETA_WINDOW_MS = 10 * 60_000;
export const PASSAGE_ETA_WARMUP_MS = 3 * 60_000;
export const PASSAGE_ETA_STOP_MS = 90_000;
const MAX_SAMPLE_GAP_MS = 35_000;
const MAX_SAMPLES = 128;
const STOP_KTS = 0.5;
const MAX_SPEED_KTS = 100;

export interface PassageEtaInput {
    routeKey: object | null;
    remainingNm: number | null;
    cruiseKts: number;
    departureMs: number | null;
    forecastOn: boolean;
}

export interface PassageEta {
    arrivalMs: number | null;
    speedKts: number | null;
    basis: 'cruise' | 'average' | 'stopped' | 'unavailable';
    sampleMinutes: number;
}

export interface PassageSpeedObservation {
    /** Original speed observation time, not the phone's receipt/poll time. */
    at: number;
    speedKts: number;
    source: string;
}

export interface PassageSpeedSummary {
    averageKts: number | null;
    sampleMinutes: number;
    stopped: boolean;
}

export interface PassagePositionObservation {
    at: number;
    lat: number;
    lon: number;
    source: string;
}

const validSpeed = (speed: number): boolean => Number.isFinite(speed) && speed >= 0 && speed <= MAX_SPEED_KTS;
const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Pi speed has no source clock yet: derive motion only from its genuine timed fixes. */
export class PassagePositionSpeed {
    private positions: PassagePositionObservation[] = [];
    private lastSpeed: PassageSpeedObservation | null = null;

    clear(): void {
        this.positions = [];
        this.lastSpeed = null;
    }

    observe(position: PassagePositionObservation | null, now: number): PassageSpeedObservation | null {
        if (
            !position ||
            !position.source ||
            !Number.isFinite(position.at) ||
            position.at <= 0 ||
            position.at > now + 1_000 ||
            now - position.at > MAX_SAMPLE_GAP_MS ||
            !Number.isFinite(position.lat) ||
            !Number.isFinite(position.lon) ||
            Math.abs(position.lat) > 90 ||
            Math.abs(position.lon) > 180 ||
            (position.lat === 0 && position.lon === 0)
        ) {
            this.clear();
            return null;
        }
        let last: PassagePositionObservation | undefined = this.positions[this.positions.length - 1];
        if (last && (last.source !== position.source || position.at - last.at > MAX_SAMPLE_GAP_MS)) {
            this.clear();
            last = undefined;
        }
        if (last && position.at === last.at)
            return position.lat === last.lat && position.lon === last.lon ? this.lastSpeed : null;
        if (last && position.at < last.at) {
            this.clear();
            return null;
        }
        if (last) {
            const span = position.at - last.at;
            if (span < 5_000) return this.lastSpeed;
            const hopSpeed = calculateDistance(last.lat, last.lon, position.lat, position.lon) / (span / 3_600_000);
            if (!validSpeed(hopSpeed)) {
                this.clear();
                this.positions.push({ ...position });
                return null;
            }
        }
        this.positions.push({ ...position });
        while (this.positions.length > 1 && this.positions[0].at < position.at - 60_000) this.positions.shift();
        if (this.positions.length > 16) this.positions.splice(0, this.positions.length - 16);
        const first = this.positions[0];
        const span = position.at - first.at;
        if (span < 30_000) return null;
        const speed = calculateDistance(first.lat, first.lon, position.lat, position.lon) / (span / 3_600_000);
        // At a mooring a few metres of GPS scatter is not forward progress.
        this.lastSpeed = { at: position.at, source: position.source, speedKts: speed < 1 ? 0 : speed };
        return this.lastSpeed;
    }
}

/** One route/session/source only; polling duplicates cannot manufacture observed minutes. */
export class PassageSpeedHistory {
    private samples: PassageSpeedObservation[] = [];
    private stoppedSince: number | null = null;

    clear(): void {
        this.samples = [];
        this.stoppedSince = null;
    }

    observe(observation: PassageSpeedObservation | null, now: number): void {
        if (
            !observation ||
            !validSpeed(observation.speedKts) ||
            !observation.source ||
            !Number.isFinite(observation.at) ||
            observation.at <= 0 ||
            observation.at > now + 1_000 ||
            now - observation.at > MAX_SAMPLE_GAP_MS
        ) {
            this.clear();
            return;
        }
        let last: PassageSpeedObservation | undefined = this.samples[this.samples.length - 1];
        if (last && (last.source !== observation.source || observation.at - last.at > MAX_SAMPLE_GAP_MS)) {
            this.clear();
            last = undefined;
        }
        if (last && observation.at <= last.at) return;
        this.samples.push({ ...observation });
        const cutoff = observation.at - PASSAGE_ETA_WINDOW_MS;
        // Retain the point immediately before the boundary for its clipped interval.
        while (this.samples.length > 1 && this.samples[1].at <= cutoff) this.samples.shift();
        if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
        // A single GPS spike should neither fabricate a stop nor end one.
        const recent = this.samples.slice(-3).map((sample) => sample.speedKts);
        if (median(recent) <= STOP_KTS) this.stoppedSince ??= observation.at;
        else this.stoppedSince = null;
    }

    summary(now: number): PassageSpeedSummary {
        const empty = { averageKts: null, sampleMinutes: 0, stopped: false };
        const last = this.samples[this.samples.length - 1];
        if (!last || now - last.at > MAX_SAMPLE_GAP_MS || last.at > now + 1_000) {
            this.clear();
            return empty;
        }
        const cutoff = last.at - PASSAGE_ETA_WINDOW_MS;
        const since = Math.max(this.samples[0].at, cutoff);
        const duration = last.at - since;
        const sampleMinutes = Math.min(10, Math.floor(duration / 60_000));
        const stopped = this.stoppedSince !== null && last.at - this.stoppedSince >= PASSAGE_ETA_STOP_MS;
        if (stopped) return { averageKts: null, sampleMinutes, stopped: true };
        if (duration < PASSAGE_ETA_WARMUP_MS) return { ...empty, sampleMinutes };

        // Minute-bucket medians suppress isolated speed spikes. Each bucket is
        // weighted by observed elapsed time, not its number of received samples.
        const buckets = new Map<number, number[]>();
        for (const sample of this.samples) {
            const bucket = Math.floor(sample.at / 60_000);
            const values = buckets.get(bucket) ?? [];
            values.push(sample.speedKts);
            buckets.set(bucket, values);
        }
        const speeds = new Map([...buckets].map(([bucket, values]) => [bucket, median(values)]));
        let weighted = 0;
        let covered = 0;
        for (let i = 0; i < this.samples.length - 1; i += 1) {
            const sample = this.samples[i];
            const span = this.samples[i + 1].at - Math.max(sample.at, cutoff);
            if (span <= 0) continue;
            weighted += (speeds.get(Math.floor(sample.at / 60_000)) ?? sample.speedKts) * span;
            covered += span;
        }
        const averageKts = covered > 0 ? weighted / covered : null;
        return { averageKts: averageKts !== null && averageKts > STOP_KTS ? averageKts : null, sampleMinutes, stopped };
    }
}

export function calculatePassageEta(
    input: PassageEtaInput,
    history: PassageSpeedSummary | null,
    now: number,
): PassageEta {
    const unavailable: PassageEta = { arrivalMs: null, speedKts: null, basis: 'unavailable', sampleMinutes: 0 };
    if (!input.routeKey || input.remainingNm === null || !Number.isFinite(input.remainingNm) || input.remainingNm < 0)
        return unavailable;
    const scheduled = input.forecastOn && input.departureMs !== null;
    const start = scheduled ? input.departureMs! : now;
    if (!Number.isFinite(start)) return unavailable;
    if (!scheduled && history?.stopped)
        return { arrivalMs: null, speedKts: 0, basis: 'stopped', sampleMinutes: history.sampleMinutes };
    const average = !scheduled && history?.averageKts != null ? history.averageKts : null;
    const speed = average ?? input.cruiseKts;
    if (!validSpeed(speed) || speed <= 0) return unavailable;
    const arrival = start + (input.remainingNm / speed) * 3_600_000;
    if (!Number.isFinite(arrival) || Math.abs(arrival) > 8.64e15) return unavailable;
    return {
        arrivalMs: Math.round(arrival / 60_000) * 60_000,
        speedKts: Math.round(speed * 10) / 10,
        basis: average === null ? 'cruise' : 'average',
        sampleMinutes: scheduled ? 0 : (history?.sampleMinutes ?? 0),
    };
}

/** Avoid a one-minute ETA wobble; material changes and basis changes remain visible. */
export function stabilizePassageEta(previous: PassageEta, next: PassageEta): PassageEta {
    const arrivalMs =
        previous.basis === next.basis &&
        previous.arrivalMs !== null &&
        next.arrivalMs !== null &&
        Math.abs(previous.arrivalMs - next.arrivalMs) <= 60_000
            ? previous.arrivalMs
            : next.arrivalMs;
    if (
        arrivalMs === previous.arrivalMs &&
        next.speedKts === previous.speedKts &&
        next.basis === previous.basis &&
        next.sampleMinutes === previous.sampleMinutes
    )
        return previous;
    return { ...next, arrivalMs };
}
