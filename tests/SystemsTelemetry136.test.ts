import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSystemsExtra, appendSystemsExtra } from '../pi-cache/src/systemsTelemetry';
import { readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { mergeOnboardSensors } from '../pi-cache/src/onboardSensors';
import { parseSystemsTelemetry } from '../services/systemsTelemetry';
import { snapshotFromWire } from '../services/telemetryWire';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
const T = 1_800_000_000_000;
const leaf = (value: unknown, unit: string, at = T, source = 'venus.1') => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: source,
    meta: { units: unit },
});
function doc() {
    return {
        electrical: {
            batteries: {
                bank1: {
                    voltage: leaf(13.4, 'V', T - 1000),
                    current: leaf(-5, 'A', T - 2000),
                    capacity: { stateOfCharge: leaf(0.78, 'ratio', T - 3000) },
                },
            },
            solar: { solar1: { panelPower: leaf(125, 'W') } },
            ac: { bus1: { phase: { single: { realPower: leaf(350, 'W') } } } },
            chargers: { charger1: { temperature: leaf(300.15, 'K') } },
        },
        tanks: { freshWater: { tank1: { currentLevel: leaf(0.5, 'ratio') } } },
        steering: { autopilot: { state: leaf('standby', '') } },
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());
describe('bounded selected systems telemetry', () => {
    it('round-trips actual units, signs and independent original times through the unchanged relay', () => {
        const source = doc(),
            bus = readTelemetrySnapshot(source, () => T)!;
        const supplemented = mergeOnboardSensors(
            bus,
            { barometer: { available: false, latest: null, reason: 'none', samples: [] } },
            T,
        )!;
        const body = buildTelemetryBody(supplemented, 'generated-system-test');
        const parsed = parseTelemetryBody(body, T);
        if (!parsed.ok) throw Error(parsed.error);
        expect(parsed.row.extra).toEqual(body.extra);
        const values = snapshotFromWire({ ...parsed.row }, 'lan')!.snapshot.systemsReadings!;
        expect(values.find((x) => x.kind === 'b')).toEqual({
            kind: 'b',
            instance: 'bank1',
            source: 'venus.1',
            values: [
                { value: 13.4, at: T - 1000 },
                { value: -5, at: T - 2000 },
                { value: 78, at: T - 3000 },
            ],
        });
        expect(values.find((x) => x.kind === 'f')?.values[0]).toEqual({ value: 50, at: T });
        expect(values.find((x) => x.kind === 'c')?.values[2]).toEqual({ value: 27, at: T });
        expect(values.find((x) => x.kind === 's')?.values[0]?.value).toBe(125);
        expect(values.find((x) => x.kind === 'a')?.instance).toBe('bus1/single');
        expect(values.find((x) => x.kind === 'p')?.values[0]?.value).toBe(1);
        expect(snapshotFromWire({ ...body, source: 'device' }, 'cloud')!.snapshot.systemsReadings).toEqual([]);
    });
    it('retains a tank-only document without any GPS, RPM, battery voltage or other navigation scalar', () => {
        const source = { tanks: { freshWater: { tank1: { currentLevel: leaf(0.4, 'ratio', T - 5000) } } } };
        const bus = readTelemetrySnapshot(source, () => T)!;
        expect(bus).not.toBeNull();
        expect(bus.voltageV).toBeNull();
        expect(bus.rpm).toBeNull();
        expect(bus.lat).toBeNull();
        const merged = mergeOnboardSensors(
            bus,
            { barometer: { available: false, latest: null, reason: 'none', samples: [] } },
            T,
        )!;
        expect(
            parseSystemsTelemetry(buildTelemetryBody(merged, 'generated').extra as Record<string, unknown>, T),
        ).toMatchObject([{ kind: 'f', values: [{ value: 40, at: T - 5000 }] }]);
        expect(merged.reportedAt).toBe(new Date(T).toISOString());
    });
    it('a stalled GPS clock cannot erase qualified fresh systems or revive navigation values', () => {
        const source = {
            ...doc(),
            navigation: {
                datetime: { value: new Date(T - 700_000).toISOString() },
                position: { value: { latitude: 30, longitude: -60 } },
            },
        };
        const bus = readTelemetrySnapshot(source, () => T)!;
        const merged = mergeOnboardSensors(
            bus,
            { barometer: { available: false, latest: null, reason: 'none', samples: [] } },
            T,
        )!;
        expect(merged.lat).toBeNull();
        expect(merged.sogKts).toBeNull();
        const body = buildTelemetryBody(merged, 'generated');
        expect(
            snapshotFromWire(body, 'lan')?.snapshot.systemsReadings?.find((x) => x.kind === 'b')?.values[0]?.at,
        ).toBe(T - 1000);
    });
    it('does not combine different selected senders on the same named bank', () => {
        const source = doc();
        source.electrical.batteries.bank1.current = leaf(-5, 'A', T, 'other.2');
        const banks = parseSystemsTelemetry(readSystemsExtra(source, T), T).filter((x) => x.kind === 'b');
        expect(banks).toHaveLength(2);
        expect(banks.find((x) => x.source === 'venus.1')?.values[1]).toBeNull();
        expect(banks.find((x) => x.source === 'other.2')?.values[0]).toBeNull();
    });
    it('never substitutes a parent/document clock or accepts wrong units, numeric strings, missing identity or future/old leaves', () => {
        const source = doc();
        source.electrical.batteries.bank1.voltage = leaf(13.4, 'mV');
        source.electrical.batteries.bank1.current = leaf('-5', 'A');
        source.electrical.batteries.bank1.capacity.stateOfCharge = leaf(0.78, 'ratio', T - 180001);
        source.tanks.freshWater.tank1.currentLevel = leaf(0.5, 'ratio', T + 1001);
        source.electrical.solar.solar1.panelPower = leaf(100, 'W', T, '');
        const pilot = source.steering.autopilot.state;
        delete (pilot as { timestamp?: string }).timestamp;
        const result = parseSystemsTelemetry(
            readSystemsExtra({ ...source, timestamp: new Date(T).toISOString() }, T),
            T,
        );
        expect(result.map((x) => x.kind).sort()).toEqual(['a', 'c']);
    });
    it('caps discovered instances and packs without relabelling an unknown sender', () => {
        const source = doc();
        source.electrical.batteries = Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => ['bank' + i, { voltage: leaf(12, 'V') }]),
        ) as typeof source.electrical.batteries;
        const values = readSystemsExtra(source, T);
        expect(Object.keys(values).length).toBeLessThanOrEqual(8);
        expect(parseSystemsTelemetry(values, T).some((x) => x.kind === 'b')).toBe(false);
        for (const raw of Object.values(values)) expect(raw.length).toBeLessThanOrEqual(120);
    });
    it('appends only after every existing critical and trailing key; a full budget is unchanged', () => {
        const optional = readSystemsExtra(doc(), T),
            critical = Object.fromEntries(Array.from({ length: 39 }, (_, i) => ['critical_' + i, i]));
        critical.ais_watch_push = 1;
        expect(appendSystemsExtra(critical, optional)).toEqual(critical);
        const bus = readTelemetrySnapshot(doc(), () => T)!;
        bus.extra = Object.fromEntries(Array.from({ length: 36 }, (_, i) => ['critical_' + i, i]));
        const body = buildTelemetryBody(
            bus,
            'generated',
            { ais_watch: 'armed', ais_watch_at_ms: T },
            { ais_watch_push: 'ready' },
        );
        const keys = Object.keys(body.extra as object);
        expect(keys).toHaveLength(40);
        expect(keys.at(-2)).toBe('ais_watch_push');
        expect(keys.at(-1)).toMatch(/^sys_/);
        const parsed = parseTelemetryBody(body, T);
        if (!parsed.ok) throw Error(parsed.error);
        expect(parsed.row.extra).toEqual(body.extra);
    });
    it('never evicts old extras or overflows the byte cap to fit optional data', () => {
        const critical = Object.fromEntries(Array.from({ length: 27 }, (_, i) => ['field' + i, '\u00e9'.repeat(60)]));
        const result = appendSystemsExtra(critical, readSystemsExtra(doc(), T))!;
        for (const [key, value] of Object.entries(critical)) expect(result[key]).toBe(value);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    });
    it.each([
        '[]',
        '[1,"b","bank","s",1800000000000,1,null,null,null,null,null]',
        '[1,"p","pilot","s",1800000000000,0.5,0]',
        '[1,"f","tank","s",1800000000000,101,0]',
        '[1,"f","tank","s",1800000001001,5,0]',
        'x'.repeat(121),
    ])('ignores malformed optional scalar %s', (raw) => {
        expect(parseSystemsTelemetry({ sys_0_v1: raw }, T)).toEqual([]);
    });
    it('repeat polling never renews the original leaf clocks', () => {
        const values = readSystemsExtra(doc(), T);
        expect(parseSystemsTelemetry(values, T + 10000)[0].values[0]?.at).toBe(T - 1000);
        expect(parseSystemsTelemetry(values, T + 180001)).toEqual([]);
    });
});
