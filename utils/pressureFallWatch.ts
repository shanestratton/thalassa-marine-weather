import { pressureFallAlarm, type TendencyReading } from './barometerTendency';

/** One notification per sustained episode. Missing/stale data never fires or clears. */
export class PressureFallWatch {
    private source = '';
    private since: number | null = null;
    private clearing: number | null = null;
    private alerted = false;
    evaluate(reading: TendencyReading | null, latestAt: number | null, now: number, source: string): boolean {
        if (source !== this.source) {
            this.source = source;
            this.since = this.clearing = null;
            this.alerted = false;
        }
        if (!reading || latestAt == null || latestAt > now + 1000 || now - latestAt > 120_000) {
            this.since = this.clearing = null;
            return false;
        }
        if (pressureFallAlarm(reading)) {
            this.clearing = null;
            this.since ??= latestAt;
            // A stalled last sample cannot supply two minutes of confirmation.
            if (!this.alerted && latestAt - this.since >= 120_000) {
                this.alerted = true;
                return true;
            }
        } else {
            this.since = null;
            // Hysteresis: a borderline oscillation cannot repeatedly rearm.
            if (reading.delta3h >= -2.5 && (reading.rawDelta3h ?? reading.delta3h) >= -2.5) {
                this.clearing ??= now;
                if (now - this.clearing >= 5 * 60_000) this.alerted = false;
            } else this.clearing = null;
        }
        return false;
    }
}
