/**
 * barometer — the boat's own BMP390, sampled continuously and remembered.
 *
 * Why the boat's sensor rather than the phone's: a barometer is only worth
 * carrying for its TENDENCY, and a phone cannot supply one. It goes ashore in
 * a pocket, up and down the companionway, and every metre of that altitude
 * change reads as pressure change — roughly 0.12 hPa per metre, so a trip up
 * the dock ramp swamps the 1-2 hPa/3h that actually means something. It is
 * also asleep or absent most of the time, so its "three-hour" trend is really
 * "since you last opened the app".
 *
 * This sensor is bolted to the boat and mains-powered. It does not move and it
 * does not sleep, so the record is continuous and altitude-stable — which is
 * exactly what makes a tendency trustworthy. Measured against ECMWF MSLP on
 * install (2026-09-02): 1022.13 vs 1022.6 hPa, inside its rated absolute
 * accuracy, so it also needs none of the forecast-anchoring the phone path
 * does.
 *
 * The reading itself is delegated to scripts/bmp390.py — Python because
 * smbus2 is already aboard and adding a native I2C binding to this service
 * would mean another thing that compiles at deploy time.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * dist/ sits one level under the package root, alongside scripts/ — verified
 * against the real deployment at /opt/thalassa-pi-cache. BAROMETER_READER
 * overrides it for a Pi whose sensor script lives elsewhere, or for testing
 * the sampler without a full redeploy.
 */
const READER = process.env.BAROMETER_READER || join(HERE, '..', 'scripts', 'bmp390.py');

/** One minute: fine enough to see a squall line, cheap enough to ignore. */
const SAMPLE_INTERVAL_MS = 60_000;
/** Twelve hours, so the three-hour tendency survives a restart with room to spare. */
const HISTORY_MS = 12 * 3_600_000;
/** A read is a 200 ms conversion; anything past this is a wiring fault, not slowness. */
const READ_TIMEOUT_MS = 5_000;
/** Stop logging the same failure forever — say it once, then once an hour. */
const FAILURE_LOG_INTERVAL_MS = 3_600_000;

export interface BarometerSample {
    /** hPa, Bosch-compensated. */
    hpa: number;
    /** Enclosure temperature in degC — NOT air temperature; it self-heats. */
    tempC: number;
    /** ms epoch. */
    at: number;
}

export interface BarometerState {
    available: boolean;
    /** Why not, when unavailable — shown to the skipper rather than swallowed. */
    reason: string | null;
    latest: BarometerSample | null;
    samples: BarometerSample[];
}

export class Barometer {
    private samples: BarometerSample[] = [];
    private available = false;
    private reason: string | null = 'not started';
    private timer: ReturnType<typeof setInterval> | null = null;
    private reading = false;
    private lastFailureLoggedAt = 0;
    private readonly storePath: string;

    constructor(cacheDir: string) {
        this.storePath = join(cacheDir, 'barometer.json');
    }

    /** Begin sampling. Safe to call when no sensor is fitted — it simply reports unavailable. */
    async start(): Promise<void> {
        await this.load();
        if (!existsSync(READER)) {
            this.reason = 'reader script not deployed';
            return;
        }
        await this.sample();
        // unref so a shutting-down process is never held open by the timer.
        this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    state(): BarometerState {
        this.trim();
        return {
            available: this.available,
            reason: this.available ? null : this.reason,
            latest: this.samples.length > 0 ? this.samples[this.samples.length - 1] : null,
            samples: this.samples,
        };
    }

    private trim(): void {
        const cutoff = Date.now() - HISTORY_MS;
        if (this.samples.length > 0 && this.samples[0].at < cutoff) {
            this.samples = this.samples.filter((s) => s.at >= cutoff);
        }
    }

    private async sample(): Promise<void> {
        // Never overlap: a wedged I2C read must not stack up a queue of them.
        if (this.reading) return;
        this.reading = true;
        try {
            const out = await new Promise<string>((resolve, reject) => {
                execFile('python3', [READER, '--json'], { timeout: READ_TIMEOUT_MS }, (error, stdout) =>
                    error ? reject(error) : resolve(stdout),
                );
            });
            const parsed = JSON.parse(out) as { pressure_hpa?: unknown; temp_c?: unknown };
            const hpa = typeof parsed.pressure_hpa === 'number' ? parsed.pressure_hpa : NaN;
            const tempC = typeof parsed.temp_c === 'number' ? parsed.temp_c : NaN;
            // Sanity floor/ceiling: the lowest and highest sea-level pressures
            // ever recorded on earth are ~870 and ~1084 hPa. Anything outside
            // that is a bus error dressed up as a number.
            if (!Number.isFinite(hpa) || hpa < 800 || hpa > 1100) {
                throw new Error(`implausible reading ${String(parsed.pressure_hpa)}`);
            }
            this.samples.push({ hpa, tempC: Number.isFinite(tempC) ? tempC : 0, at: Date.now() });
            this.trim();
            this.available = true;
            this.reason = null;
            await this.persist();
        } catch (error) {
            this.available = false;
            this.reason = error instanceof Error ? error.message.slice(0, 200) : 'read failed';
            const now = Date.now();
            if (now - this.lastFailureLoggedAt > FAILURE_LOG_INTERVAL_MS) {
                this.lastFailureLoggedAt = now;
                console.warn(`[BARO] read failed: ${this.reason}`);
            }
        } finally {
            this.reading = false;
        }
    }

    /** The record is the point, so it has to survive a restart. */
    private async persist(): Promise<void> {
        try {
            await mkdir(dirname(this.storePath), { recursive: true });
            await writeFile(this.storePath, JSON.stringify({ samples: this.samples }), 'utf8');
        } catch {
            /* a read-only or full disk must not stop the sampling */
        }
    }

    private async load(): Promise<void> {
        try {
            const raw = await readFile(this.storePath, 'utf8');
            const parsed = JSON.parse(raw) as { samples?: unknown };
            if (Array.isArray(parsed.samples)) {
                this.samples = parsed.samples.filter(
                    (s): s is BarometerSample =>
                        typeof s === 'object' &&
                        s !== null &&
                        typeof (s as BarometerSample).hpa === 'number' &&
                        typeof (s as BarometerSample).at === 'number',
                );
                this.trim();
            }
        } catch {
            /* no history yet — the first sample starts one */
        }
    }
}
