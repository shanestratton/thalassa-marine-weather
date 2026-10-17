import { describe, expect, it } from 'vitest';
import { SignalKReadState } from '../utils/signalkProtocol';
import { directSignalKSnapshot } from '../services/signalk/snapshot';
import { remoteInstrumentEvidence } from '../services/instruments/evidence';
import { measuredCurrent } from '../services/instruments/measuredCurrent';
import {
    phoneMayStandInForBoat,
    resolveKind,
    resolveLane,
    describeBoatLink,
    UNKNOWN_NETWORK,
} from '../services/boatLink/boatLinkModel';
import { signalKDeviceOrigin } from '../services/signalk/config';
const NOW = 1_800_000_000_000,
    self = 'urn:mrn:imo:mmsi:000000001';
const leaf = (value: unknown, at = NOW - 2000, units?: string) => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: 'fictional',
    ...(units ? { meta: { units } } : {}),
});
function doc() {
    return {
        uuid: self,
        navigation: {
            position: leaf({ latitude: 0, longitude: 0 }),
            speedOverGround: leaf(3),
            courseOverGroundTrue: leaf(0),
            headingTrue: leaf(0),
            speedThroughWater: leaf(2),
            leewayAngle: leaf(-0.02),
        },
        environment: { wind: { speedTrue: leaf(5), angleTrueWater: leaf(0.5), directionTrue: leaf(1) } },
    };
}
describe('direct Signal K source, units, freshness and navigation privilege', () => {
    it('projects SI with original clocks, real zero coordinates and signed measured leeway', () => {
        const state = new SignalKReadState(self, NOW);
        state.ingestSelfDocument(doc(), NOW);
        const s = directSignalKSnapshot(state.document(), 'fictional-session', NOW);
        expect(s).toMatchObject({
            source: 'device',
            via: 'signalk',
            lat: 0,
            lon: 0,
            headingTrueAt: NOW - 2000,
            positionSampleAt: NOW - 2000,
        });
        expect(s.sogKts).toBeCloseTo(5.83153347);
        expect(s.gaugeTimes?.sog).toBe(NOW - 2000);
        expect(s.leewayDeg).toBeCloseTo(-1.14591559);
        const current = measuredCurrent(remoteInstrumentEvidence(s), NOW);
        expect(current).toMatchObject({
            kind: 'available',
            via: 'signalk',
            leewaySource: 'Direct Signal K measured signed leeway',
        });
        expect(remoteInstrumentEvidence(s).readings.stw?.source).toBe('Direct Signal K measured leaf');
    });
    it('does not date an old/null/undated heading from fresh GPS/receipt or convert magnetic to true', () => {
        const d = doc();
        d.navigation.headingTrue = leaf(1, NOW - 14000);
        Object.assign(d.navigation, { headingMagnetic: leaf(1) });
        let s = directSignalKSnapshot(d, 'fictional', NOW);
        expect(s.headingTrueDeg).toBeNull();
        expect(measuredCurrent(remoteInstrumentEvidence(s), NOW)).toMatchObject({
            kind: 'unavailable',
            reason: 'true-heading-required',
        });
        Object.assign(d.navigation, { headingTrue: { value: 1, $source: 'fictional' } });
        s = directSignalKSnapshot(d, 'fictional', NOW);
        expect(s.headingTrueDeg).toBeNull();
    });
    it('refuses wrong declared units, future clocks and missing wind independently', () => {
        const d = doc();
        d.navigation.speedThroughWater = leaf(5, NOW - 1000, 'kn');
        d.navigation.headingTrue = leaf(0, NOW + 2000);
        const s = directSignalKSnapshot(d, 'fictional', NOW);
        expect(s.stwKts).toBeNull();
        expect(s.headingTrueDeg).toBeNull();
        expect(s.awsKts).toBeNull();
        expect(s.twsKts).toBeCloseTo(9.71922246);
    });
    it('reports any positive engine RPM but never makes a multi-engine aggregate one engine hourmeter', () => {
        const d = { ...doc(), propulsion: { port: { revolutions: leaf(10) }, starboard: { revolutions: leaf(20) } } };
        expect(directSignalKSnapshot(d, 'fictional', NOW)).toMatchObject({
            rpm: 1200,
            rpmEngineCount: 2,
            rpmAtMs: NOW - 2000,
        });
        expect(directSignalKSnapshot(d, 'fictional', NOW).rpmEngineId).toBeUndefined();
        delete (d.propulsion as Partial<typeof d.propulsion>).starboard;
        Object.assign(d.propulsion.port, {
            runTime: leaf(3600, NOW - 3000, 's'),
            coolantTemperature: leaf(353.15, NOW - 1000, 'K'),
            oilPressure: leaf(300000, NOW - 2000, 'Pa'),
        });
        expect(directSignalKSnapshot(d, 'fictional', NOW)).toMatchObject({
            rpmEngineId: 'port',
            rpmEngineCount: 1,
            engineTelemetry: {
                engineId: 'port',
                runTime: { value: 3600, at: NOW - 3000 },
                coolant: { value: 80, at: NOW - 1000 },
                oilPressure: { value: 300, at: NOW - 2000 },
            },
        });
    });
    it('keeps declared keel depth; never relabels a raw reading or cached DBS as keel clearance', () => {
        const d = {
            ...doc(),
            environment: { depth: { belowKeel: leaf(-0.1), belowTransducer: leaf(1.5), transducerToKeel: leaf(1.6) } },
        };
        expect(directSignalKSnapshot(d, 'fictional', NOW)).toMatchObject({
            depthM: -0.1,
            depthReference: 'below-keel',
        });
        d.environment.depth.belowKeel = leaf(-0.1, NOW - 20000);
        expect(directSignalKSnapshot(d, 'fictional', NOW)).toMatchObject({
            depthM: 1.5,
            depthReference: 'below-transducer',
        });
        d.environment.depth.belowTransducer = leaf(1.5, NOW - 20000);
        Object.assign(d.environment.depth, { belowSurface: leaf(1.5) });
        expect(directSignalKSnapshot(d, 'fictional', NOW).depthM).toBeNull();
    });
    it('names a distinct read lane and never derives LAN/phone substitution permission from it', () => {
        expect(
            resolveLane({ status: 'remote', source: 'device', via: 'signalk', readingAt: NOW, usableReading: true }),
        ).toBe('signalk');
        expect(
            resolveKind({
                lane: 'signalk',
                where: 'aboard',
                network: UNKNOWN_NETWORK,
                pi: { answeredVia: null, seenFrom: null },
                gatewayHost: null,
            }),
        ).toBe('direct');
        expect(
            phoneMayStandInForBoat({
                lane: 'signalk',
                where: { where: 'aboard', reason: 'together', separationM: 0 },
                data: 'live',
                directEvidence: true,
            }),
        ).toBe(false);
        const w = describeBoatLink({
            lane: 'signalk',
            kind: 'direct',
            where: { where: 'unknown', reason: 'no-phone-fix', separationM: null },
            networkName: 'your VPN',
            data: { state: 'live', ageMs: 2000 },
            setup: { piPaired: false, gatewaySaved: false, gatewayLabel: 'gateway', signalkConfigured: true },
            socket: { status: 'disconnected', owner: 'none' },
        });
        expect(w.line).toContain('Signal K');
        expect(w.statusRow).toContain('read only');
        expect(w.hub.status).toContain('Signal K');
    });
    it.each([
        'https://boat.example/path',
        'https://name:password@boat.example',
        'http://boat.example',
        'http://10.0.0.1.example',
        'https://boat.example/?token=bad',
    ])('refuses unsafe origin %s', (origin) => expect(() => signalKDeviceOrigin(origin, true)).toThrow());
    it('requires an explicit private-LAN HTTP exception; normal TLS remains available globally', () => {
        expect(() => signalKDeviceOrigin('http://192.168.50.2:3000')).toThrow();
        expect(signalKDeviceOrigin('http://192.168.50.2:3000', true)).toBe('http://192.168.50.2:3000');
        expect(signalKDeviceOrigin('https://boat.example')).toBe('https://boat.example');
    });
});
