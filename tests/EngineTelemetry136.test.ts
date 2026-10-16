import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEngineMetrics, readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { parseEngineTelemetry } from '../services/instruments/engineTelemetry';
import { snapshotFromWire } from '../services/telemetryWire';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { remoteInstrumentEvidence } from '../services/instruments/evidence';
import {
    endEngineRunCounter,
    engineRunSummary,
    newEngineRunCounter,
    observeEngineEvidence,
} from '../services/shiplog/engineRunCounter';
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
    it('binds a paired Pi meter to the actual vessel, even when both engines are named main', () => {
        const read = (uuid: string, at: number) => {
            const doc = { uuid, ...document() };
            doc.propulsion.main.revolutions = leaf(20, 'Hz', at);
            const body = buildTelemetryBody(readTelemetrySnapshot(doc, () => at)!, 'same-paired-pi');
            expect(Object.keys(body.extra ?? {}).length).toBeLessThanOrEqual(40);
            expect(JSON.stringify(body)).not.toContain(uuid);
            const snap = snapshotFromWire(body, 'lan')!.snapshot;
            snap.windHistoryIdentity = 'same-paired-pi';
            expect(snap.rpmVesselKey).toMatch(/^[a-f0-9]{24}$/);
            return remoteInstrumentEvidence(snap);
        };
        const first = read('urn:mrn:signalk:uuid:fictional-one', T);
        let c = observeEngineEvidence(newEngineRunCounter('pi-vessel-swap', T), first, T);
        c = observeEngineEvidence(c, read('urn:mrn:signalk:uuid:fictional-two', T + 2000), T + 2000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 2, unknownSeconds: 8 });
        expect(c.rpmFeedIdentity).toBe(first.meterIdentity);
    });
    it('keeps the vessel identity when bounded metrics fall back to the existing RPM source scalar', () => {
        const doc = { uuid: 'urn:mrn:signalk:uuid:fictional-one', ...document() };
        const id = 'e'.repeat(64);
        const large = { ...doc, propulsion: { [id]: doc.propulsion.main } };
        const body = buildTelemetryBody(readTelemetrySnapshot(large, () => T)!, 'fictional');
        const extra = body.extra as Record<string, unknown>;
        expect(extra.engine_metrics_v1).toBeUndefined();
        expect(String(extra.instrument_rpm_source_v1).length).toBeLessThanOrEqual(120);
        const snap = snapshotFromWire(body, 'lan')!.snapshot;
        expect(snap.rpmEngineId).toBe(id);
        expect(snap.rpmVesselKey).toMatch(/^[a-f0-9]{24}$/);
        expect(remoteInstrumentEvidence(snap).meterIdentity).toMatch(/^signalk-vessel:/);
    });
    it('keeps old Pi gauges but cannot assign their missing vessel identity to a maintenance meter', () => {
        const body = buildTelemetryBody(readTelemetrySnapshot(document(), () => T)!, 'fictional');
        const snap = snapshotFromWire(body, 'lan')!.snapshot;
        expect(snap.rpm).toBe(1200);
        expect(snap.engineTelemetry?.coolant?.value).toBe(80);
        const c = endEngineRunCounter(
            observeEngineEvidence(newEngineRunCounter('legacy-pi', T), remoteInstrumentEvidence(snap), T),
            T + 10_000,
        );
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 0, unknownSeconds: 10 });
    });
    it('rejects conflicting packed vessel metadata and never mistakes a vessel-only pack for engine metrics', () => {
        const key = 'a'.repeat(24);
        expect(
            parseEngineTelemetry(JSON.stringify([2, 'main', T, null, null, null, null, null, null, key]), T),
        ).toBeUndefined();
        const body = buildTelemetryBody(
            readTelemetrySnapshot({ uuid: 'urn:fictional:one', ...document() }, () => T)!,
            'fictional',
        );
        (body.extra as Record<string, unknown>).instrument_rpm_source_v1 = JSON.stringify([1, 'main', 'b'.repeat(24)]);
        const snap = snapshotFromWire(body, 'lan')!.snapshot;
        expect(snap.rpmVesselKey).toBeUndefined();
        expect(snap.rpmEngineId).toBeUndefined();
        expect(snap.engineTelemetry).toBeUndefined();
    });
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
