/** Optional local yacht sensors. Same adapter feeds LAN and cloud; no gateway sockets. */
import { open } from 'node:fs/promises';
import type { BarometerState } from './barometer.js';
import type { TelemetrySnapshot } from './trackSignalk.js';

type Json = Record<string, unknown>;
const bounded = (v: unknown, low: number, high: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
const fresh = (at: unknown, now: number, age: number): at is number => bounded(at, now - age, now + 5_000);

export interface OnboardSensorSources {
    barometer: BarometerState;
    wind?: Json | null;
    house?: Json | null;
    shipTimeZone?: string;
}

/** Pure merge for tests. Only a named house SmartShunt with a source timestamp is accepted. */
export function mergeOnboardSensors(
    bus: TelemetrySnapshot | null,
    sources: OnboardSensorSources,
    now = Date.now(),
): TelemetrySnapshot | null {
    // A stalled GPS clock must neither block fresh standalone sensors nor be
    // relabelled as a current position. Discard the old bus as a whole first.
    if (bus && !fresh(Date.parse(bus.reportedAt), now, 600_000)) bus = null;
    const result: TelemetrySnapshot = bus
        ? { ...bus }
        : {
              reportedAt: new Date(now).toISOString(),
              lat: null,
              lon: null,
              sogKts: null,
              cogDeg: null,
              headingDeg: null,
              stwKts: null,
              twsKts: null,
              twaDeg: null,
              twdDeg: null,
              awsKts: null,
              awaDeg: null,
              depthM: null,
              heelDeg: null,
              pitchDeg: null,
              waterTempC: null,
              pressureHpa: null,
              rudderDeg: null,
              rpm: null,
              voltageV: null,
          };
    const extra = { ...bus?.extra };
    const b = sources.barometer;
    if (b.available && b.latest && fresh(b.latest.at, now, 180_000) && bounded(b.latest.hpa, 850, 1100)) {
        result.pressureHpa = b.latest.hpa;
        extra.pressure_at = b.latest.at;
        const target = b.latest.at - 3 * 3_600_000;
        const old = b.samples
            .filter((s) => bounded(s.at, target - 300_000, target + 300_000) && bounded(s.hpa, 850, 1100))
            .sort((a, c) => Math.abs(a.at - target) - Math.abs(c.at - target))[0];
        if (old) {
            extra.pressure_3h_hpa = old.hpa;
            extra.pressure_3h_at = old.at;
        }
    }
    const house = sources.house;
    if (
        house?.source === 'victron-smartshunt-house' &&
        fresh(house.at, now, 180_000) &&
        bounded(house.soc_pct, 0, 100)
    ) {
        extra.house_battery_soc_pct = house.soc_pct;
        extra.house_battery_at = house.at;
    }
    const wind = sources.wind;
    const times = wind?.sensor_at_ms && typeof wind.sensor_at_ms === 'object' ? (wind.sensor_at_ms as Json) : {};
    if (wind?.connected === true && wind.attitude_ok !== false && fresh(wind.generated_at_ms, now, 10_000)) {
        for (const [field, target] of [
            ['heel', 'heelDeg'],
            ['pitch', 'pitchDeg'],
        ] as const) {
            const value = wind[field];
            // Yacht Devices uses 63.75 degrees for unavailable, not a spectacular heel.
            if (
                result[target] === null &&
                fresh(times[field], now, 30_000) &&
                bounded(value, -90, 90) &&
                Math.abs(value) !== 63.75
            ) {
                result[target] = value;
                extra[`${field}_at`] = times[field] as number;
            }
        }
    }
    if (sources.shipTimeZone) {
        try {
            new Intl.DateTimeFormat('en', { timeZone: sources.shipTimeZone }).format(now);
            extra.ship_time_zone = sources.shipTimeZone;
        } catch {
            /* Do not use an implicit machine/visitor time zone. */
        }
    }
    if (
        !bus &&
        !Object.entries(result).some(([k, v]) => k !== 'reportedAt' && v !== null) &&
        !('house_battery_soc_pct' in extra)
    )
        return null;
    result.extra = extra;
    return result;
}

/** Paths are explicitly configured by the skipper, never taken from a network request. */
async function readSensorFile(file: string | undefined): Promise<Json | null> {
    if (!file) return null;
    let handle;
    try {
        handle = await open(file, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65_536) return null;
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

export function createOnboardSupplement(options: {
    barometer: () => BarometerState;
    windFile?: string;
    houseBatteryFile?: string;
    shipTimeZone?: string;
    now?: () => number;
}) {
    return async (bus: TelemetrySnapshot | null): Promise<TelemetrySnapshot | null> => {
        const [wind, house] = await Promise.all([
            readSensorFile(options.windFile),
            readSensorFile(options.houseBatteryFile),
        ]);
        return mergeOnboardSensors(
            bus,
            { barometer: options.barometer(), wind, house, shipTimeZone: options.shipTimeZone },
            (options.now ?? Date.now)(),
        );
    };
}
