import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import {
    resolveAutomaticCanalExit,
    VERIFIED_CANAL_EXIT_PROFILES,
    type VerifiedCanalExitProfile,
} from '../services/automaticCanalExit';
import type { CanalPoint } from '../services/canalDepartureGeometry';

// Synthetic geometry tests only. These coordinates are not an operational exit.
const now = Date.parse('2026-09-13T00:00:00Z');
const p = (x: number, y: number): CanalPoint => ({
    lon: 153 + x / (111_320 * Math.cos((-27 * Math.PI) / 180)),
    lat: -27 + y / 111_320,
});
const ring = (w: number, s: number, e: number, n: number) =>
    [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ].map(([x, y]) => {
        const { lon, lat } = p(x, y);
        return [lon, lat];
    });
const gate = (id: string, x: number, y: number, width = 40): VerifiedCanalExitProfile['gates'][number] => ({
    port: { id: `${id}-port`, ...p(x - width / 2, y), objectClass: 'BOYLAT', catlam: 1 },
    starboard: { id: `${id}-starboard`, ...p(x + width / 2, y), objectClass: 'BCNLAT', catlam: 2 },
});
const profile = (): VerifiedCanalExitProfile => ({
    id: 'synthetic-channel',
    label: 'Synthetic channel',
    departureArea: { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100)] },
    sourceRevision: 'synthetic-test-revision-1',
    source: {
        authority: 'Test fixture, not a chart authority',
        reference: 'Synthetic terminal-pair and channel-rule fixture',
        publishedAt: '2026-09-10T00:00:00Z',
    },
    reviewedAt: '2026-09-12T00:00:00Z',
    validUntil: '2026-09-19T00:00:00Z',
    terminalVerified: true,
    rule: 'centreline-permitted',
    gates: [gate('inner', 0, 200), gate('terminal', 0, 300)],
    outboundBearingDeg: 0,
});
const resolve = (
    profiles: readonly VerifiedCanalExitProfile[] = [profile()],
    start = p(0, 0),
    destination: CanalPoint | null = p(0, 1000),
) => resolveAutomaticCanalExit(start, destination, profiles, now);
const mutated = (change: (v: VerifiedCanalExitProfile) => void) => {
    const value = profile();
    change(value);
    return value;
};

describe('reviewed automatic canal exits', () => {
    it('ships only the reviewed Newport profile, not a universal marker heuristic', () => {
        expect(VERIFIED_CANAL_EXIT_PROFILES.map((p) => p.id)).toEqual(['newport-waterways-northbound-v1']);
        expect(VERIFIED_CANAL_EXIT_PROFILES.every((p) => p.terminalVerified && p.chartEvidence?.length)).toBe(true);
        expect(Object.isFrozen(VERIFIED_CANAL_EXIT_PROFILES)).toBe(true);
        expect(resolve(VERIFIED_CANAL_EXIT_PROFILES)).toEqual({
            status: 'manual-required',
            reason: 'No reviewed channel exit covers this departure. Choose Canal Exit on the chart.',
        });
    });

    it('selects exact pair midpoints in reviewed order and retains provenance and expiry', () => {
        const value = profile();
        const result = resolve([value]);
        expect(result).toEqual({
            status: 'resolved',
            profileId: value.id,
            label: value.label,
            sourceRevision: value.sourceRevision,
            validUntil: value.validUntil,
            gateCentres: value.gates.map(({ port, starboard }) => ({
                lat: (port.lat + starboard.lat) / 2,
                lon: (port.lon + starboard.lon) / 2,
            })),
            outboundBearingDeg: 0,
            exit: p(0, 300),
        });
        expect(resolve([value], p(0, 0), null).status).toBe('resolved');
        if (result.status === 'resolved') {
            result.exit.lon = 0;
            result.gateCentres[0].lat = 0;
            expect(resolve([value]).status).toBe('resolved');
            expect(value.gates[0].port.lat).toBe(p(-20, 200).lat);
        }
    });

    it('does not reorder a bending channel by distance, numbering or nearest marker', () => {
        const value = profile();
        value.gates = [gate('9', 400, 200), gate('2', 0, 300)];
        const result = resolve([value]);
        expect(result.status).toBe('resolved');
        if (result.status === 'resolved') {
            expect(result.gateCentres).toEqual(
                value.gates.map(({ port, starboard }) => ({
                    lat: (port.lat + starboard.lat) / 2,
                    lon: (port.lon + starboard.lon) / 2,
                })),
            );
            expect(result.exit).toEqual(p(0, 300));
        }
    });

    it.each([
        [100, 0],
        [100, 100],
        [101, 0],
        [-101, 0],
    ])('does not select an outer boundary or point outside (%s, %s)', (x, y) => {
        expect(resolve([profile()], p(x, y)).status).toBe('manual-required');
    });

    it('respects holes and refuses their boundaries', () => {
        const value = profile();
        value.departureArea.coordinates.push(ring(-20, -20, 20, 20));
        expect(resolve([value], p(0, 0)).status).toBe('manual-required');
        expect(resolve([value], p(20, 0)).status).toBe('manual-required');
        expect(resolve([value], p(40, 0)).status).toBe('resolved');
    });

    it('fails closed on overlapping profiles and a shared boundary', () => {
        const a = profile(),
            b = profile();
        b.id = 'other-reviewed-channel';
        expect(resolve([a, b]).status).toBe('manual-required');
        b.departureArea.coordinates = [ring(0, -100, 200, 100)];
        expect(resolve([a, b], p(0, 0)).status).toBe('manual-required');
    });

    it('rejects duplicate profile identities and conflicting marker coordinates across records', () => {
        const a = profile(),
            b = profile();
        b.departureArea.coordinates = [ring(1000, -100, 1200, 100)];
        expect(resolve([a, b]).status).toBe('manual-required');
        b.id = 'other-channel';
        b.gates[0].port.lon += 0.0001;
        expect(resolve([a, b]).status).toBe('manual-required');
    });

    it.each([
        (v: VerifiedCanalExitProfile) => {
            v.validUntil = '2026-09-13T00:00:00Z';
        },
        (v: VerifiedCanalExitProfile) => {
            v.reviewedAt = '2026-09-14T00:00:00Z';
        },
        (v: VerifiedCanalExitProfile) => {
            v.source.publishedAt = '2026-09-14T00:00:00Z';
        },
        (v: VerifiedCanalExitProfile) => {
            v.source.publishedAt = '2026-09-12T12:00:00Z';
        },
        (v: VerifiedCanalExitProfile) => {
            v.reviewedAt = '2026-02-30T00:00:00Z';
        },
        (v: VerifiedCanalExitProfile) => {
            v.validUntil = 'not a date';
        },
        (v: VerifiedCanalExitProfile) => {
            v.source.authority = '';
        },
        (v: VerifiedCanalExitProfile) => {
            v.source.reference = '';
        },
        (v: VerifiedCanalExitProfile) => {
            v.sourceRevision = '';
        },
    ])('rejects stale, future or malformed provenance %#', (change) => {
        expect(resolve([mutated(change)]).status).toBe('manual-required');
    });

    it('invalidates the same reviewed profile at expiry, not just when first selected', () => {
        const value = profile();
        expect(resolve([value]).status).toBe('resolved');
        expect(resolveAutomaticCanalExit(p(0, 0), p(0, 1000), [value], Date.parse(value.validUntil)).status).toBe(
            'manual-required',
        );
    });

    it.each([
        { terminalVerified: false },
        { rule: 'keep-to-starboard' },
        { outboundBearingDeg: NaN },
        { outboundBearingDeg: 360 },
        { gates: [] },
        { gates: Array.from({ length: 25 }, (_, i) => gate(`${i}`, 0, 200 + 100 * i)) },
    ])('requires complete review and bounded real gate inventory: %j', (patch) => {
        expect(resolve([{ ...profile(), ...patch } as VerifiedCanalExitProfile]).status).toBe('manual-required');
    });

    it.each([
        (v: VerifiedCanalExitProfile) => {
            v.gates[0].port.id = v.gates[1].port.id;
        },
        (v: VerifiedCanalExitProfile) => {
            Object.assign(v.gates[0].port, v.gates[0].starboard, { id: 'distinct' });
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates[0].port.catlam = 2;
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates[0].starboard.catlam = 1;
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates[0].port.lat = Infinity;
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates[0].port.lon = 190;
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates = [gate('too-narrow', 0, 300, 10)];
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates = [gate('too-wide', 0, 300, 610)];
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates = [gate('a', 0, 300), gate('b', 0, 300, 60)];
        },
        (v: VerifiedCanalExitProfile) => {
            v.gates = [...v.gates].reverse();
        },
    ])('rejects conflicting, malformed or reversed gate data %#', (change) => {
        expect(resolve([mutated(change)]).status).toBe('manual-required');
    });

    it('rejects invented halves, special-purpose marks and missing partners', () => {
        for (const objectClass of ['synthetic-half', 'BOYSPP', 'BCNSPP', undefined]) {
            const value = profile();
            Object.assign(value.gates[0].port, { objectClass });
            expect(resolve([value]).status).toBe('manual-required');
        }
        const value = profile();
        Object.assign(value.gates[0], { starboard: null });
        expect(resolve([value]).status).toBe('manual-required');
    });

    it.each([
        { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100).slice(0, -1)] },
        {
            type: 'Polygon',
            coordinates: [
                [
                    [153, -27],
                    [153, -27],
                    [153, -27],
                    [153, -27],
                ],
            ],
        },
        { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100), ring(90, 90, 110, 110)] },
        { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100), ring(-100, -20, -80, 20)] },
        { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100), ring(-20, -20, 20, 20), ring(0, 0, 40, 40)] },
        { type: 'Polygon', coordinates: [ring(-100, -100, 100, 100), ring(-20, -20, 20, 20), ring(-10, -10, 10, 10)] },
        {
            type: 'Polygon',
            coordinates: [
                [
                    [152, -28],
                    [154, -28],
                    [154, -26],
                    [152, -26],
                    [152, -28],
                ],
            ],
        },
        { type: 'Polygon', coordinates: [null] },
        { type: 'MultiPolygon', coordinates: [] },
    ])('rejects malformed or non-local departure areas %#', (area) => {
        const value = profile();
        value.departureArea = area as Polygon;
        expect(resolve([value]).status).toBe('manual-required');
    });

    it('rejects a self-crossing departure ring', () => {
        const value = profile();
        const r = ring(-100, -100, 100, 100);
        value.departureArea.coordinates = [[r[0], r[2], r[1], r[3], r[0]]];
        expect(resolve([value]).status).toBe('manual-required');
    });

    it('does not depart and re-enter for a destination in the same area or on its edge', () => {
        expect(resolve([profile()], p(0, 0), p(50, 50)).status).toBe('manual-required');
        expect(resolve([profile()], p(0, 0), p(100, 0)).status).toBe('manual-required');
        expect(resolve([profile()], p(0, 0), p(0, 310)).status).toBe('manual-required');
    });

    it('requires at least 20 m from departure to terminal gate', () => {
        const value = profile();
        value.departureArea.coordinates = [ring(-100, -100, 100, 400)];
        expect(resolve([value], p(0, 290)).status).toBe('manual-required');
    });

    it('fails closed for invalid inputs without throwing', () => {
        expect(resolve([profile()], { lat: NaN, lon: 153 }).status).toBe('manual-required');
        expect(resolve([profile()], p(0, 0), { lat: 91, lon: 153 }).status).toBe('manual-required');
        expect(resolveAutomaticCanalExit(p(0, 0), null, [profile()], NaN).status).toBe('manual-required');
        expect(resolve([null] as unknown as VerifiedCanalExitProfile[]).status).toBe('manual-required');
    });
});
