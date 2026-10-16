import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEngineMetrics, readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { parseEngineTelemetry } from '../services/instruments/engineTelemetry';
import { snapshotFromWire } from '../services/telemetryWire';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
const T = 1_800_000_000_000;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());
const leaf = (value: number, unit: string, at = T) => ({
    value,
    timestamp: new Date(at).toISOString(),
    meta: { units: unit },
});
function document() {
    return {
        propulsion: {
            main: {
                revolutions: leaf(20, 'Hz'),
                runTime: leaf(36000, 's', T - 4000),
                coolantTemperature: leaf(353.15, 'K', T - 2000),
                oilPressure: leaf(300000, 'Pa'),
            },
        },
    };
}
describe('engine telemetry sensor-clock contract', () => {
    it('round-trips actual Signal K units without replacing original leaf times', () => {
        const doc = document();
        const packed = readEngineMetrics(doc, T)!;
        expect(packed.length).toBeLessThanOrEqual(120);
        expect(parseEngineTelemetry(packed, T)).toEqual({
            engineId: 'main',
            runTime: { value: 36000, at: T - 4000 },
            coolant: { value: 80, at: T - 2000 },
            oilPressure: { value: 300, at: T },
        });
        const body = buildTelemetryBody(readTelemetrySnapshot(doc, () => T)!, 'fictional');
        const reading = snapshotFromWire(body, 'lan')!;
        expect(reading.snapshot.engineTelemetry?.coolant).toEqual({ value: 80, at: T - 2000 });
    });
    it('refuses mixed engines and does not mistake general engine temperature for coolant', () => {
        const doc = document();
        Object.assign(doc.propulsion, { second: { revolutions: leaf(0, 'Hz') } });
        expect(readEngineMetrics(doc, T)).toBeNull();
        expect(parseEngineTelemetry('[2,"main",1800000000000,3600,0,null,null,null,null]', T)).toBeUndefined();
        const single = { propulsion: { main: { revolutions: leaf(20, 'Hz'), temperature: leaf(353.15, 'K') } } };
        expect(readEngineMetrics(single, T)).toBeNull();
    });
    it('keeps wrong-unit, expired and future leaves unknown independently', () => {
        const doc = document();
        doc.propulsion.main.runTime = leaf(36000, 'h');
        doc.propulsion.main.coolantTemperature = leaf(353.15, 'K', T - 14000);
        doc.propulsion.main.oilPressure = leaf(300000, 'Pa', T + 1);
        expect(readEngineMetrics(doc, T)).toBeNull();
        doc.propulsion.main.runTime = leaf(36000, 's');
        expect(parseEngineTelemetry(readEngineMetrics(doc, T), T)).toEqual({
            engineId: 'main',
            runTime: { value: 36000, at: T },
        });
    });
    it.each([
        '[]',
        '[1,"main",1800000000000,1,null,null,null,null,null]',
        '[1,"main",1800000000000,1,-1,null,null,null,null]',
        '[1,"main",1800000000000,null,null,300,0,null,null]',
        '[1,"main",1800000000000,null,null,null,null,-1,0]',
        'x'.repeat(121),
    ])('rejects malformed or impossible packed data %s', (raw) => {
        expect(parseEngineTelemetry(raw, T)).toBeUndefined();
    });
});
