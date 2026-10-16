/** Always-on boat pressure: BMP390, then timestamped Signal K outside pressure.
 * Daily append files retain ten days without rewriting the record each minute. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const READER =
    process.env.BAROMETER_READER || join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'bmp390.py');
export const BAROMETER_HISTORY_MS = 10 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const SAMPLE_MS = 60_000;
const MAX_SAMPLES = BAROMETER_HISTORY_MS / SAMPLE_MS + 1;
const DAY_FILE = /^pressure-\d{4}-\d{2}-\d{2}\.jsonl$/;

export interface BarometerSample {
    hpa: number;
    /** Sensor enclosure temperature, not outside air. */
    tempC: number;
    at: number;
    source?: 'bmp390' | 'signalk';
    lat?: number;
    lon?: number;
}
export interface BarometerState {
    available: boolean;
    reason: string | null;
    latest: BarometerSample | null;
    samples: BarometerSample[];
}
interface Options {
    now?: () => number;
    readSensor?: () => Promise<{ pressure_hpa: number; temp_c?: number }>;
    fetchImpl?: typeof fetch;
    signalkOrigin?: string;
    readPosition?: () => Promise<{ lat: number; lon: number } | null>;
}
const valid = (s: unknown): s is BarometerSample => {
    if (!s || typeof s !== 'object') return false;
    const p = s as BarometerSample;
    return Number.isFinite(p.hpa) && p.hpa >= 800 && p.hpa <= 1100 && Number.isFinite(p.at);
};

export class Barometer {
    private samples: BarometerSample[] = [];
    private available = false;
    private reason: string | null = 'not started';
    private timer: ReturnType<typeof setInterval> | null = null;
    private reading = false;
    private lastFailureLoggedAt = 0;
    private cleanedDay = '';
    private readonly dir: string;
    private readonly now: () => number;
    constructor(
        private readonly cacheDir: string,
        private readonly options: Options = {},
    ) {
        this.dir = join(cacheDir, 'barometer');
        this.now = options.now ?? Date.now;
    }
    async start(): Promise<void> {
        if (this.timer) return;
        await this.load();
        await this.sample();
        this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
        this.timer.unref?.();
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
    state(): BarometerState {
        this.trim();
        const latest = this.samples.at(-1) ?? null;
        const live = this.available && latest !== null && this.now() - latest.at <= 2 * SAMPLE_MS;
        return {
            available: live,
            reason: live ? null : (this.reason ?? 'pressure sample is stale'),
            latest,
            samples: [...this.samples],
        };
    }
    private trim(): void {
        const now = this.now();
        this.samples = this.samples
            .filter((s) => valid(s) && s.at >= now - BAROMETER_HISTORY_MS && s.at <= now + 1000)
            .slice(-MAX_SAMPLES);
    }
    private async bmp(): Promise<BarometerSample> {
        const parsed = this.options.readSensor
            ? await this.options.readSensor()
            : await new Promise<{ pressure_hpa: number; temp_c?: number }>((resolve, reject) => {
                  if (!existsSync(READER)) return reject(new Error('reader script not deployed'));
                  execFile('python3', [READER, '--json'], { timeout: 5_000 }, (error, stdout) => {
                      if (error) return reject(error);
                      try {
                          resolve(JSON.parse(stdout));
                      } catch (err) {
                          reject(err);
                      }
                  });
              });
        const sample: BarometerSample = {
            hpa: parsed.pressure_hpa,
            tempC: Number.isFinite(parsed.temp_c) ? parsed.temp_c! : 0,
            at: this.now(),
            source: 'bmp390',
        };
        if (!valid(sample)) throw new Error('invalid BMP390 pressure');
        return sample;
    }
    private async signalK(): Promise<BarometerSample> {
        const origin = this.options.signalkOrigin ?? process.env.SIGNALK_ORIGIN ?? 'http://127.0.0.1:3000';
        const response = await (this.options.fetchImpl ?? fetch)(
            origin.replace(/\/$/, '') + '/signalk/v1/api/vessels/self/environment/outside/pressure',
            { signal: AbortSignal.timeout(5_000) },
        );
        if (!response.ok) throw new Error('Signal K pressure unavailable');
        const leaf = (await response.json()) as { value?: unknown; timestamp?: unknown };
        const at = typeof leaf.timestamp === 'string' ? Date.parse(leaf.timestamp) : NaN;
        const sample: BarometerSample = {
            hpa: typeof leaf.value === 'number' ? leaf.value / 100 : NaN,
            tempC: 0,
            at,
            source: 'signalk',
        };
        if (!valid(sample) || at > this.now() + 1000 || this.now() - at > 2 * SAMPLE_MS)
            throw new Error('Signal K pressure is stale or invalid');
        return sample;
    }
    /** One minute sampler; exposed for hardware-free verification. */
    async sample(): Promise<void> {
        if (this.reading) return;
        this.reading = true;
        try {
            const sample = await this.bmp().catch(() => this.signalK());
            const position = await this.position();
            if (position) Object.assign(sample, position);
            const previous = this.samples.at(-1);
            // A repeated bus timestamp is not a new observation.
            if (!previous || sample.at > previous.at) {
                this.samples.push(sample);
                this.trim();
                await this.persist(sample);
            }
            this.available = true;
            this.reason = null;
        } catch (error) {
            this.available = false;
            this.reason = error instanceof Error ? error.message.slice(0, 200) : 'read failed';
            if (this.now() - this.lastFailureLoggedAt > 3_600_000) {
                this.lastFailureLoggedAt = this.now();
                console.warn('[BARO] read failed: ' + this.reason);
            }
        } finally {
            this.reading = false;
        }
    }
    private async position(): Promise<{ lat: number; lon: number } | null> {
        try {
            if (this.options.readPosition) return await this.options.readPosition();
            const origin = this.options.signalkOrigin ?? process.env.SIGNALK_ORIGIN ?? 'http://127.0.0.1:3000';
            const response = await (this.options.fetchImpl ?? fetch)(
                origin.replace(/\/$/, '') + '/signalk/v1/api/vessels/self/navigation/position',
                { signal: AbortSignal.timeout(5_000) },
            );
            if (!response.ok) return null;
            const leaf = (await response.json()) as {
                value?: { latitude?: unknown; longitude?: unknown };
                timestamp?: string;
            };
            const at = Date.parse(leaf.timestamp ?? '');
            const lat = leaf.value?.latitude;
            const lon = leaf.value?.longitude;
            if (
                typeof lat !== 'number' ||
                typeof lon !== 'number' ||
                !Number.isFinite(lat) ||
                !Number.isFinite(lon) ||
                Math.abs(lat) > 90 ||
                Math.abs(lon) > 180 ||
                !Number.isFinite(at) ||
                at > this.now() + 1000 ||
                this.now() - at > 2 * SAMPLE_MS
            )
                return null;
            return { lat, lon };
        } catch {
            return null;
        }
    }
    private async persist(sample: BarometerSample): Promise<void> {
        try {
            await mkdir(this.dir, { recursive: true });
            const day = new Date(this.now()).toISOString().slice(0, 10);
            // Leading newline isolates a partial final write after power loss.
            await appendFile(
                join(this.dir, 'pressure-' + day + '.jsonl'),
                '\n' + JSON.stringify(sample) + '\n',
                'utf8',
            );
            if (day !== this.cleanedDay) {
                for (const name of await readdir(this.dir)) {
                    if (
                        DAY_FILE.test(name) &&
                        Date.parse(name.slice(9, 19)) + DAY_MS <= this.now() - BAROMETER_HISTORY_MS
                    )
                        await unlink(join(this.dir, name));
                }
                this.cleanedDay = day;
            }
        } catch {
            /* A full/read-only disk does not stop the sensor. */
        }
    }
    private async load(): Promise<void> {
        const loaded: BarometerSample[] = [];
        try {
            for (const name of (await readdir(this.dir))
                .filter((n) => DAY_FILE.test(n))
                .sort()
                .slice(-11)) {
                for (const line of (await readFile(join(this.dir, name), 'utf8')).split('\n')) {
                    try {
                        const s: unknown = JSON.parse(line);
                        if (valid(s)) loaded.push(s);
                    } catch {
                        /* partial line */
                    }
                }
            }
        } catch {
            /* First run. */
        }
        // Preserve the twelve-hour record on upgrade; never rewrite it.
        try {
            const old = JSON.parse(await readFile(join(this.cacheDir, 'barometer.json'), 'utf8')) as {
                samples?: unknown[];
            };
            if (Array.isArray(old.samples))
                loaded.push(
                    ...old.samples.filter(valid).map((s) => ({ ...s, source: s.source ?? ('bmp390' as const) })),
                );
        } catch {
            /* No legacy record. */
        }
        this.samples = [...new Map(loaded.sort((a, b) => a.at - b.at).map((s) => [s.at, s])).values()];
        this.trim();
    }
}
