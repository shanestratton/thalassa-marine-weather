import { describe, expect, it } from 'vitest';
import { moveAutoroutingDisplayWaypoint } from '../services/autoroutingWaypointEdit';
import { buildTrialWaypointPlan, type TrialDisplayWaypoint } from '../services/autoroutingDisplayWaypoints';
import type { AutoroutingTrialRoute } from '../types/autorouting';

type Point = [number, number];

function fixture(
    coordinates: Point[] = [
        [0, 0],
        [0.01, 0],
        [0.02, 0.01],
        [0.03, 0.01],
        [0.04, 0.01],
    ],
): AutoroutingTrialRoute {
    return {
        id: 'original-proposal',
        createdAt: '2026-09-13T01:00:00.000Z',
        provider: 'SevenCs',
        coordinates,
        warnings: ['Original chart and clearance warning.'],
        providerCheck: {
            status: 'unsafe',
            findings: [
                {
                    featureIndex: 3,
                    severity: 'danger',
                    message: 'Original obstruction finding',
                    geometry: { type: 'Point', coordinates: [0.02, 0.01] },
                },
            ],
        },
        source: { rtz: '<original-provider-rtz/>', geoJson: '{"original":"provider-data"}' },
        vesselProfile: {
            length: { status: 'measured', valueM: 12 },
            beam: { status: 'measured', valueM: 4 },
            airDraft: { status: 'missing' },
            draftStatus: 'measured',
        },
    };
}

function plan(route: AutoroutingTrialRoute): TrialDisplayWaypoint[] {
    return buildTrialWaypointPlan(
        route.coordinates,
        route.canalDeparture ? [route.canalDeparture.handoverIndex] : [],
        route.localEdit?.waypointIndices ?? [],
    ).waypoints;
}

function vertex(route: AutoroutingTrialRoute, index: number): TrialDisplayWaypoint {
    const waypoint = plan(route).find((candidate) => candidate.pathIndex === index);
    expect(waypoint).toBeDefined();
    return waypoint!;
}

function firstSpacing(route: AutoroutingTrialRoute): TrialDisplayWaypoint {
    const waypoint = plan(route).find((candidate) => !Number.isInteger(candidate.pathIndex));
    expect(waypoint).toBeDefined();
    return waypoint!;
}

describe('local autorouting display-waypoint edits', () => {
    it('replaces exactly one integer source vertex and retains every other hidden point', () => {
        const route = fixture();
        const before = structuredClone(route);
        const result = moveAutoroutingDisplayWaypoint(route, vertex(route, 2), [0.022, 0.012]);
        expect(result.pathIndex).toBe(2);
        expect(result.route.coordinates).toEqual([
            ...route.coordinates.slice(0, 2),
            [0.022, 0.012],
            ...route.coordinates.slice(3),
        ]);
        expect(route).toEqual(before);
        expect(result.route).not.toBe(route);
        result.route.coordinates.forEach((point, index) => expect(point).not.toBe(route.coordinates[index]));
        expect(result.route.localEdit?.waypointIndices).toEqual([2]);
    });

    it('inserts a fractional sparse pin without shortcutting either original neighbour or hidden geometry', () => {
        const route = fixture(Array.from({ length: 1000 }, (_, i): Point => [153 + i * 0.004, -27]));
        const waypoint = firstSpacing(route);
        const insertion = Math.ceil(waypoint.pathIndex);
        const result = moveAutoroutingDisplayWaypoint(route, waypoint, [waypoint.coordinates[0], -26.999]);
        expect(result.pathIndex).toBe(insertion);
        expect(result.route.coordinates).toHaveLength(1001);
        expect(result.route.coordinates.slice(0, insertion)).toEqual(route.coordinates.slice(0, insertion));
        expect(result.route.coordinates.slice(insertion + 1)).toEqual(route.coordinates.slice(insertion));
        expect(result.route.coordinates[insertion - 1]).toEqual(route.coordinates[insertion - 1]);
        expect(result.route.coordinates[insertion + 1]).toEqual(route.coordinates[insertion]);
        expect(result.route.localEdit?.originalProposal.coordinates).toEqual(route.coordinates);
    });

    it('retains danger findings and exact source only as detached immutable ORIGINAL evidence, never a current provider pass', () => {
        const route = fixture();
        const result = moveAutoroutingDisplayWaypoint(route, vertex(route, 2), [0.022, 0.012]).route;
        const original = result.localEdit!.originalProposal;
        expect(result.providerCheck).toBeUndefined();
        expect(result.source).toBeUndefined();
        expect(original.providerCheck).toEqual(route.providerCheck);
        expect(original.source).toEqual(route.source);
        expect(result.warnings).toEqual(route.warnings);
        expect(result.localEdit?.checksInvalidated).toBe('provider-and-canal');
        expect(result.id).toBe(route.id);
        expect(result.createdAt).toBe(route.createdAt);
        expect(Object.isFrozen(original)).toBe(true);
        expect(Object.isFrozen(original.coordinates)).toBe(true);
        expect(Object.isFrozen(original.coordinates[0])).toBe(true);
        expect(Object.isFrozen(original.providerCheck?.findings[0].geometry)).toBe(true);
        route.coordinates[0][0] = 50;
        route.providerCheck!.findings[0].message = 'changed input';
        route.source!.rtz = 'changed input';
        route.warnings[0] = 'changed input';
        route.vesselProfile!.beam = { status: 'missing' };
        expect(original.coordinates[0]).toEqual([0, 0]);
        expect(original.providerCheck?.findings[0].message).toBe('Original obstruction finding');
        expect(original.source?.rtz).toBe('<original-provider-rtz/>');
        expect(result.warnings).toEqual(['Original chart and clearance warning.']);
        expect(result.vesselProfile?.beam).toEqual({ status: 'measured', valueM: 4 });
        expect(() => original.coordinates[0].splice(0, 1, 99)).toThrow();
    });

    it('allows an internal canal corner edit but marks all gate evidence historical', () => {
        const route = fixture();
        route.canalDeparture = { handoverIndex: 3 };
        const result = moveAutoroutingDisplayWaypoint(route, vertex(route, 2), [0.021, 0.012]).route;
        expect(result.canalDeparture?.handoverIndex).toBe(3);
        expect(result.localEdit?.checksInvalidated).toBe('provider-and-canal');
        expect(result.localEdit?.originalProposal.canalDeparture?.handoverIndex).toBe(3);
        expect(result.localEdit?.originalProposal.coordinates).toEqual(route.coordinates);
    });

    it('shifts the handover index when a fractional move inserts before it, retaining the exact gate centre', () => {
        const route = fixture([
            [153, -27],
            [155, -27],
            [157, -27],
        ]);
        route.canalDeparture = { handoverIndex: 1 };
        const waypoint = firstSpacing(route);
        expect(waypoint.pathIndex).toBeLessThan(1);
        const result = moveAutoroutingDisplayWaypoint(route, waypoint, [waypoint.coordinates[0], -26.999]).route;
        expect(result.canalDeparture?.handoverIndex).toBe(2);
        expect(result.coordinates[2]).toEqual([155, -27]);
        expect(result.localEdit?.originalProposal.canalDeparture?.handoverIndex).toBe(1);
        expect(vertex(result, 1).kind).toBe('turn');
        expect(vertex(result, 2).kind).toBe('handover');
    });

    it('protects moved sub-five-metre pins against resimplification and increments revision without rebasing original evidence', () => {
        const route = fixture([
            [153, -27],
            [155, -27],
        ]);
        const waypoint = firstSpacing(route);
        const first = moveAutoroutingDisplayWaypoint(route, waypoint, [waypoint.coordinates[0], -26.99999]).route;
        expect(first.localEdit?.revision).toBe(1);
        const pin = vertex(first, 1);
        expect(pin.kind).toBe('turn');
        const second = moveAutoroutingDisplayWaypoint(first, pin, [pin.coordinates[0], -26.99998]).route;
        expect(second.localEdit?.revision).toBe(2);
        expect(second.localEdit?.waypointIndices).toEqual([1]);
        expect(second.localEdit?.originalProposal).toEqual(first.localEdit?.originalProposal);
        expect(second.localEdit?.originalProposal.coordinates).toHaveLength(2);
        expect(second.localEdit?.originalProposal).not.toHaveProperty('localEdit');
        expect(first.coordinates[1][1]).toBe(-26.99999);
    });

    it('shifts previously moved vertex indices on an earlier fractional insertion', () => {
        const route = fixture([
            [153, -27],
            [159, -27],
        ]);
        const later = plan(route).filter((pin) => pin.kind === 'spacing')[2];
        const first = moveAutoroutingDisplayWaypoint(route, later, [later.coordinates[0], -26.99999]).route;
        expect(first.localEdit?.waypointIndices).toEqual([1]);
        const earlier = firstSpacing(first);
        expect(earlier.pathIndex).toBeLessThan(1);
        const second = moveAutoroutingDisplayWaypoint(first, earlier, [earlier.coordinates[0], -26.99998]).route;
        expect(second.localEdit?.waypointIndices).toEqual([1, 2]);
        expect(second.coordinates[2]).toEqual(first.coordinates[1]);
        expect(vertex(second, 1).kind).toBe('turn');
        expect(vertex(second, 2).kind).toBe('turn');
    });

    it.each([0, 4])('locks endpoint %s even when its supplied kind is forged', (index) => {
        const route = fixture();
        expect(() => moveAutoroutingDisplayWaypoint(route, { ...vertex(route, index), kind: 'turn' }, [1, 1])).toThrow(
            /setup/,
        );
    });

    it('locks the exact handover even if its kind is forged, without mutation', () => {
        const route = fixture();
        route.canalDeparture = { handoverIndex: 2 };
        const before = structuredClone(route);
        expect(() => moveAutoroutingDisplayWaypoint(route, { ...vertex(route, 2), kind: 'turn' }, [1, 1])).toThrow(
            /handover/,
        );
        expect(route).toEqual(before);
    });

    it('rejects a stale marker after the route changes instead of moving another source point', () => {
        const route = fixture();
        const waypoint = vertex(route, 2);
        const first = moveAutoroutingDisplayWaypoint(route, waypoint, [0.022, 0.012]).route;
        expect(() => moveAutoroutingDisplayWaypoint(first, waypoint, [0.025, 0.015])).toThrow(/changed/);
    });

    it('rejects invented fractional positions and altered display coordinates or distance', () => {
        const route = fixture();
        const waypoint = vertex(route, 2);
        for (const forged of [
            { ...waypoint, pathIndex: 1.5 },
            { ...waypoint, coordinates: [0.02, 0.011] as Point },
            { ...waypoint, distanceM: waypoint.distanceM + 1 },
        ])
            expect(() => moveAutoroutingDisplayWaypoint(route, forged, [0.022, 0.012])).toThrow(/changed/);
    });

    it.each([
        { position: [NaN, 0] },
        { position: [0, Infinity] },
        { position: [181, 0] },
        { position: [0, -91] },
        { position: [0] },
        { position: [0, 0, 0] },
    ])('rejects invalid new position $position', ({ position }) => {
        const route = fixture();
        expect(() => moveAutoroutingDisplayWaypoint(route, vertex(route, 2), position as Point)).toThrow(
            /valid longitude/,
        );
    });

    it('does not flag a no-op as edited and refuses a zero-length neighbouring leg', () => {
        const route = fixture();
        const waypoint = vertex(route, 2);
        expect(() => moveAutoroutingDisplayWaypoint(route, waypoint, waypoint.coordinates)).toThrow(
            /different position/,
        );
        expect(() => moveAutoroutingDisplayWaypoint(route, waypoint, route.coordinates[1])).toThrow(/neighbouring/);
        expect(route.localEdit).toBeUndefined();
    });

    it('refuses a fractional insert at the point limit without simplifying or dropping points', () => {
        const route = fixture(Array.from({ length: 10000 }, (_, i): Point => [153 + i * 0.0004, -27]));
        const waypoint = firstSpacing(route);
        expect(() => moveAutoroutingDisplayWaypoint(route, waypoint, [waypoint.coordinates[0], -26.99])).toThrow(
            /limit/,
        );
        expect(route.coordinates).toHaveLength(10000);
    });

    it('permits replacement at the point limit because no new vertex is inserted', () => {
        const route = fixture(Array.from({ length: 10000 }, (_, i): Point => [153 + i * 0.0004, -27]));
        route.coordinates[5000][1] = -26.99;
        const result = moveAutoroutingDisplayWaypoint(route, vertex(route, 5000), [155, -26.98]).route;
        expect(result.coordinates).toHaveLength(10000);
    });

    it('rejects malformed geometry, handover and missing original edit evidence', () => {
        const route = fixture();
        const waypoint = vertex(route, 2);
        const invalidGeometry = structuredClone(route);
        invalidGeometry.coordinates[3][0] = NaN;
        expect(() => moveAutoroutingDisplayWaypoint(invalidGeometry, waypoint, [1, 1])).toThrow(/geometry/);
        expect(() =>
            moveAutoroutingDisplayWaypoint({ ...route, canalDeparture: { handoverIndex: 1.5 } }, waypoint, [1, 1]),
        ).toThrow(/handover/);
        const edited = moveAutoroutingDisplayWaypoint(route, waypoint, [0.021, 0.012]).route;
        const missingEvidence = { ...edited, localEdit: { revision: 1 } } as AutoroutingTrialRoute;
        expect(() => moveAutoroutingDisplayWaypoint(missingEvidence, vertex(edited, 2), [1, 1])).toThrow(/evidence/);
        const corruptIndices = { ...edited, localEdit: { ...edited.localEdit!, waypointIndices: [0] } };
        expect(() => moveAutoroutingDisplayWaypoint(corruptIndices, vertex(edited, 2), [1, 1])).toThrow(/evidence/);
    });
});
