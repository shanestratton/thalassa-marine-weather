import {
    AUTOROUTING_TRIAL_MAX_POINTS,
    type AutoroutingLocalEdit,
    type AutoroutingTrialRoute,
} from '../types/autorouting';
import { buildTrialWaypointPlan, type TrialDisplayWaypoint } from './autoroutingDisplayWaypoints';
import { autoroutingProposalGeometryKey } from './autoroutingProposalEvidence';

type Position = readonly [number, number];
type OriginalProposal = AutoroutingLocalEdit['originalProposal'];

function samePosition(a: Position, b: Position): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

function validPosition(position: Position): boolean {
    return (
        Array.isArray(position) &&
        position.length === 2 &&
        Number.isFinite(position[0]) &&
        Number.isFinite(position[1]) &&
        Math.abs(position[0]) <= 180 &&
        Math.abs(position[1]) <= 90
    );
}

/** Snapshot known proposal fields only: no UI review, save state or incidental
 * properties can be carried over as evidence for the edited geometry. The
 * router's disclosure is left out (2026-10-01): it described the original
 * line, never the edited one, and it is the bulk of the route in memory. */
function snapshotOriginal(route: OriginalProposal): OriginalProposal {
    const detached = structuredClone({
        id: route.id,
        provider: route.provider,
        createdAt: route.createdAt,
        coordinates: route.coordinates,
        warnings: route.warnings,
        ...(route.vesselProfile ? { vesselProfile: route.vesselProfile } : {}),
    });
    // These fields are already bounded snapshots from the trial boundary. Keep
    // one immutable original, not a growing chain of prior edited proposals.
    const freeze = (value: unknown): void => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    };
    freeze(detached);
    return detached;
}

/**
 * Move one CURRENT display pin without replacing the full path with its sparse
 * display polyline. A fractional pin inserts a vertex and keeps BOTH original
 * neighbours; an integer pin replaces only that one full-path vertex.
 *
 * This is geometry editing, not route approval. The router's checks are
 * historical after the first move: the edited route carries no disclosure. The caller must replace the route object,
 * clear prior review/save UI and recheck every leg; saving remains blocked.
 */
export function moveAutoroutingDisplayWaypoint(
    route: AutoroutingTrialRoute,
    waypoint: TrialDisplayWaypoint,
    position: Position,
): { route: AutoroutingTrialRoute; pathIndex: number } {
    if (!route || route.provider !== 'Thalassa' || !autoroutingProposalGeometryKey(route.coordinates)) {
        throw new Error('The proposal geometry is invalid. Recalculate before moving a waypoint.');
    }
    if (!validPosition(position)) throw new Error('Enter a valid longitude and latitude for this waypoint.');
    if (
        route.localEdit !== undefined &&
        (!route.localEdit ||
            route.localEdit.checksInvalidated !== 'engine' ||
            !Number.isSafeInteger(route.localEdit.revision) ||
            route.localEdit.revision < 1 ||
            route.localEdit.revision >= Number.MAX_SAFE_INTEGER ||
            !Array.isArray(route.localEdit.waypointIndices) ||
            route.localEdit.waypointIndices.length > AUTOROUTING_TRIAL_MAX_POINTS ||
            !Array.from(route.localEdit.waypointIndices).every(
                (index) => Number.isInteger(index) && index > 0 && index < route.coordinates.length - 1,
            ) ||
            !route.localEdit.originalProposal ||
            route.localEdit.originalProposal.provider !== 'Thalassa' ||
            !autoroutingProposalGeometryKey(route.localEdit.originalProposal.coordinates))
    ) {
        throw new Error('The original proposal evidence is unavailable. Recalculate before editing.');
    }
    const editIndices = route.localEdit?.waypointIndices ?? [];
    if (!waypoint || !Number.isFinite(waypoint.pathIndex) || !validPosition(waypoint.coordinates)) {
        throw new Error('Select a current waypoint before moving it.');
    }
    const pathIndex = waypoint.pathIndex;
    if (pathIndex <= 0 || pathIndex >= route.coordinates.length - 1) {
        throw new Error('Change departure or destination in route setup, then recalculate.');
    }
    const current = buildTrialWaypointPlan(route.coordinates, [], editIndices).waypoints.find(
        (candidate) =>
            candidate.pathIndex === pathIndex &&
            candidate.kind === waypoint.kind &&
            candidate.distanceM === waypoint.distanceM &&
            samePosition(candidate.coordinates, waypoint.coordinates),
    );
    if (!current) throw new Error('The proposal changed. Select this waypoint again before moving it.');
    if (samePosition(position, current.coordinates)) throw new Error('Move the waypoint to a different position.');
    const inserted = !Number.isInteger(pathIndex);
    if (inserted && route.coordinates.length >= AUTOROUTING_TRIAL_MAX_POINTS) {
        throw new Error('This proposal has reached its waypoint limit. Nothing was changed.');
    }
    const original = snapshotOriginal(route.localEdit?.originalProposal ?? route);
    const coordinates = route.coordinates.map(([lon, lat]): [number, number] => [lon, lat]);
    const movedIndex = inserted ? Math.ceil(pathIndex) : pathIndex;
    coordinates.splice(movedIndex, inserted ? 0 : 1, [position[0], position[1]]);
    if (
        samePosition(coordinates[movedIndex], coordinates[movedIndex - 1]) ||
        samePosition(coordinates[movedIndex], coordinates[movedIndex + 1])
    ) {
        throw new Error('Keep the moved waypoint separate from its neighbouring points.');
    }
    const revision = (route.localEdit?.revision ?? 0) + 1;
    const localEdit: AutoroutingLocalEdit = Object.freeze({
        revision,
        checksInvalidated: 'engine',
        waypointIndices: Object.freeze(
            [
                ...new Set([
                    ...editIndices.map((index) => index + (inserted && index >= movedIndex ? 1 : 0)),
                    movedIndex,
                ]),
            ].sort((a, b) => a - b),
        ),
        originalProposal: original,
    });
    return {
        pathIndex: movedIndex,
        route: {
            // Keep the actual route identity/time as provenance, never invent
            // a new route or freshness timestamp for a local edit. No engine:
            // the router never saw this line.
            id: route.id,
            createdAt: route.createdAt,
            provider: 'Thalassa',
            coordinates,
            warnings: [...route.warnings],
            ...(route.vesselProfile ? { vesselProfile: structuredClone(route.vesselProfile) } : {}),
            localEdit,
        },
    };
}
