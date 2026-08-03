/**
 * Distance / unit parity guard.
 *
 * The audit found ~20-30 divergent haversine implementations across the
 * codebase (4 different earth radii, atan2-vs-asin, NM-vs-m-vs-km) with NO
 * cross-implementation test. In a nav/anchor/CPA-critical marine app, a
 * silent unit or radius drift in one copy corrupts navigation math.
 *
 * This is a READ-ONLY guard (it never edits the routing files — it only
 * imports the EXPORTED distance functions and asserts they all agree with an
 * authoritative great-circle reference within tolerance). As the duplicates
 * get consolidated onto utils/navigationCalculations, this test keeps them
 * honest. It also pins the canonical unit constants against the `3.281` vs
 * `3.28084` foot-conversion drift the audit flagged.
 *
 * NOTE: some haversine copies are PRIVATE (unexported) inside service files
 * (InshoreRouter, inshoreRouterEngine, ...) and cannot be imported here. Those
 * remain the consolidation target — see docs/CODE_AUDIT_CANDIDATES.md #2.
 * This guard covers every exported copy. MobService's distance/bearing are
 * private but now delegate to the canonical navigationCalculations functions;
 * their behaviour is asserted through the MobState seams in
 * tests/MobService.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// AnchorWatchService transitively imports AnchorWatchSyncService, whose
// module-level singleton calls `App.addListener(...).catch(...)`. The global
// mock in tests/setup.ts returns a synchronous handle (the pre-Capacitor-3
// contract), but @capacitor/app v8 returns Promise<PluginListenerHandle>, so
// the import crashes before any test runs. Override locally with the real
// async contract. (Same workaround as tests/anchorWatch.test.ts.)
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
        getInfo: vi.fn().mockResolvedValue({ name: 'Thalassa', id: 'dev.thalassa.app', build: '1', version: '1.0.0' }),
        exitApp: vi.fn(),
    },
}));

// Exported great-circle distance implementations (the ones a test can reach)
import { calculateDistance as navDistanceNm, calculateBearing as navBearingDeg } from '../utils/navigationCalculations';
import { calculateDistanceKm as mathDistanceKm } from '../utils/math';
import { calculateDistanceNM as shiplogDistanceNm } from '../services/shiplog/helpers';
import { haversineMeters as gpsBufferMeters } from '../services/shiplog/GpsTrackBuffer';
import { haversineNm as isochroneDistanceNm } from '../services/isochrone/geodesy';
import { haversineNM as gpsFollowDistanceNm } from '../utils/gpsFollow';
import { haversineNm as geoDistanceNm, bearingDeg as geoBearingDeg } from '../src/geo';
import { distanceNm as mapOfflineDistanceNm } from '../services/MapOfflineService';
// Safety-critical: the anchor-drag geofence distance + bearing (delegates to canonical)
import {
    haversineDistance as anchorWatchMeters,
    bearing as anchorWatchBearingDeg,
} from '../services/AnchorWatchService';
// Planar (equirectangular) channel-follow helpers — valid only at short range
import { distM as fairleadDistM, type LatLon } from '../services/fairlead';
import { distM as leadingLineDistM } from '../services/leadingLine';
// Canonical unit conversions
import { mToFt, ftToM } from '../utils/units';

const NM_TO_M = 1852;
const KM_TO_M = 1000;

/** Authoritative spherical great-circle distance in metres (R = 6 371 000 m). */
function refMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface Fixture {
    name: string;
    p: [number, number, number, number];
    /** roughly the great-circle length; used to pick which group is exercised */
    short: boolean;
}

const FIXTURES: Fixture[] = [
    { name: 'zero (identical point)', p: [-27.0, 153.0, -27.0, 153.0], short: true },
    { name: '~100 m (pin scale)', p: [-27.0, 153.0, -27.0, 153.001], short: true },
    { name: '~1 NM (channel)', p: [-27.0, 153.0, -27.0, 153.0187], short: true },
    { name: '~60 NM coastal (1° lat)', p: [-27.0, 153.0, -28.0, 153.0], short: false },
    { name: 'Sydney → Auckland', p: [-33.8688, 151.2093, -36.8485, 174.7633], short: false },
    { name: 'trans-Pacific LA → Sydney', p: [33.94, -118.41, -33.95, 151.18], short: false },
    { name: 'antimeridian crossing', p: [-17.0, 179.0, -17.0, -179.0], short: false },
    { name: 'high latitude (60°N)', p: [60.0, 10.0, 61.0, 11.0], short: false },
    { name: 'polar (89°N across 180°)', p: [89.0, 0.0, 89.0, 180.0], short: false },
];

// name → adapter that returns the implementation's result in METRES
const GREAT_CIRCLE: { name: string; meters: (f: Fixture['p']) => number }[] = [
    { name: 'navigationCalculations.calculateDistanceKm', meters: (p) => navDistanceNm(...p) * NM_TO_M },
    { name: 'math.calculateDistanceKm', meters: (p) => mathDistanceKm(...p) * KM_TO_M },
    { name: 'shiplog/helpers.calculateDistanceNM', meters: (p) => shiplogDistanceNm(...p) * NM_TO_M },
    { name: 'shiplog/GpsTrackBuffer.haversineMeters', meters: (p) => gpsBufferMeters(...p) },
    { name: 'isochrone/geodesy.haversineNm', meters: (p) => isochroneDistanceNm(...p) * NM_TO_M },
    { name: 'gpsFollow.haversineNM', meters: (p) => gpsFollowDistanceNm(...p) * NM_TO_M },
    { name: 'src/geo.haversineNm', meters: (p) => geoDistanceNm(...p) * NM_TO_M },
    { name: 'MapOfflineService.distanceNm', meters: (p) => mapOfflineDistanceNm(...p) * NM_TO_M },
    { name: 'AnchorWatchService.haversineDistance', meters: (p) => anchorWatchMeters(...p) },
];

describe('great-circle distance parity (single-source-of-truth guard)', () => {
    // All great-circle copies use a ~6 371 000 m radius, so they must agree
    // with the reference to a hair. A loose 0.1% catches any real unit/radius
    // drift (e.g. WGS84 6378 km, or an NM/m mix) while tolerating rounding.
    const REL_TOL = 1e-3;
    const ABS_TOL = 0.5; // metres, floor for sub-NM fixtures

    for (const fx of FIXTURES) {
        const ref = refMeters(...fx.p);
        for (const impl of GREAT_CIRCLE) {
            it(`${impl.name} matches reference @ ${fx.name}`, () => {
                const got = impl.meters(fx.p);
                expect(Math.abs(got - ref)).toBeLessThanOrEqual(Math.max(ABS_TOL, REL_TOL * ref));
            });
        }
    }
});

describe('initial-bearing parity (single-source-of-truth guard)', () => {
    /** Authoritative initial great-circle bearing, degrees [0, 360). */
    function refBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x =
            Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    const BEARINGS: { name: string; deg: (f: Fixture['p']) => number }[] = [
        { name: 'navigationCalculations.calculateBearing', deg: (p) => navBearingDeg(...p) },
        { name: 'src/geo.bearingDeg', deg: (p) => geoBearingDeg(...p) },
        { name: 'AnchorWatchService.bearing', deg: (p) => anchorWatchBearingDeg(...p) },
    ];

    const ANGLE_TOL = 0.01; // degrees — same-formula copies must agree to numerical noise

    // Bearing is undefined at zero distance — skip the identical-point fixture.
    for (const fx of FIXTURES.filter((f) => refMeters(...f.p) > 0)) {
        const ref = refBearingDeg(...fx.p);
        for (const impl of BEARINGS) {
            it(`${impl.name} matches reference @ ${fx.name}`, () => {
                const got = impl.deg(fx.p);
                // Compare on the circle so 359.999° vs 0.001° counts as 0.002° apart.
                const diff = Math.abs(((got - ref + 540) % 360) - 180);
                expect(diff).toBeLessThanOrEqual(ANGLE_TOL);
            });
        }
    }
});

describe('planar (equirectangular) distM — channel-scale validity only', () => {
    // fairlead/leadingLine use a flat-earth approximation (mPerLat 110540,
    // mPerLon 111320·cosφ). The audit flagged that these DIVERGE from
    // great-circle at range — that's expected; they're only ever called on
    // sub-NM channel geometry. Guard that they hold at channel scale so a
    // future consolidation onto the canonical haversine can't silently change
    // channel-follow behaviour. (At range they are intentionally NOT asserted.)
    const REL_TOL = 1.5e-2; // 1.5% — absorbs the flat-earth constants at short range
    const ABS_TOL = 2; // metres

    const shortFixtures = FIXTURES.filter((f) => f.short);
    for (const fx of shortFixtures) {
        const [lat1, lon1, lat2, lon2] = fx.p;
        const a: LatLon = { lat: lat1, lon: lon1 };
        const b: LatLon = { lat: lat2, lon: lon2 };
        const ref = refMeters(...fx.p);
        it(`fairlead.distM ≈ great-circle @ ${fx.name}`, () => {
            expect(Math.abs(fairleadDistM(a, b) - ref)).toBeLessThanOrEqual(Math.max(ABS_TOL, REL_TOL * ref));
        });
        it(`leadingLine.distM ≈ great-circle @ ${fx.name}`, () => {
            expect(Math.abs(leadingLineDistM(a, b) - ref)).toBeLessThanOrEqual(Math.max(ABS_TOL, REL_TOL * ref));
        });
    }
});

describe('unit conversion constants — foot-conversion drift guard', () => {
    it('mToFt uses the exact 3.28084 factor (not the drifted 3.281)', () => {
        expect(mToFt(1)).toBeCloseTo(3.28084, 5);
        expect(mToFt(1000)).toBeCloseTo(3280.84, 2);
        // The drifted 3.281 constant would give 3281.0 — must NOT match.
        expect(mToFt(1000)).not.toBeCloseTo(3281.0, 1);
    });

    it('ftToM uses the exact 0.3048 factor', () => {
        expect(ftToM(1)).toBeCloseTo(0.3048, 6);
    });

    it('metre↔foot round-trips cleanly', () => {
        // 3.28084 and 0.3048 aren't exact inverses (~3e-8 residual), so assert a
        // relative tolerance rather than fixed decimals — the exact-constant
        // checks above are the real drift guard.
        for (const m of [0, 1, 2.4, 100, 6371000]) {
            expect(Math.abs(ftToM(mToFt(m)) - m)).toBeLessThanOrEqual(Math.max(1e-6, 1e-6 * m));
        }
    });
});
