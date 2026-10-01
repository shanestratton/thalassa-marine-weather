import { AUTOROUTING_TRIAL_MAX_POINTS } from '../../types/autorouting';
import type { CataloguePlanBinding, CatalogueRouteConstraint } from './cataloguePlanningTypes';

/** The required-checkpoint budget a catalogue route may ask for (moved here
 * from types/autorouting on 2026-10-01, when Auto stopped sending checkpoint
 * constraints to a server; Plan My Day now excludes such trips). */
const CATALOGUE_MAX_REQUIRED_CHECKPOINTS = 8;

type Point = { lat: number; lon: number };

/** Only the selected directional variant supplies route limitations. This
 * preserves the existing conservative warning checks; free text is not a
 * complete tide or hazard assessment. Remote freshness is checked separately. */
export function catalogueRouteWarnings(
    binding: CataloguePlanBinding | undefined,
    constraint: CatalogueRouteConstraint | undefined,
): string[] {
    if (!constraint) return [];
    const selected = binding?.[constraint.direction];
    const matches =
        binding?.details.filter(
            (detail) => detail.id === constraint.variant.id && detail.version === constraint.variant.version,
        ) ?? [];
    const detail = matches[0];
    if (
        !binding ||
        !selected ||
        selected.variant.id !== constraint.variant.id ||
        selected.variant.version !== constraint.variant.version ||
        matches.length !== 1 ||
        detail.kind !== 'route_variant' ||
        detail.direction !== constraint.direction ||
        detail.trip.id !== binding.selection.id ||
        detail.trip.version !== binding.selection.version ||
        JSON.stringify(detail.checkpoints) !== JSON.stringify(constraint.checkpoints) ||
        !Array.isArray(detail.limitations) ||
        detail.limitations.length < 1 ||
        detail.limitations.length > 20 ||
        detail.limitations.some((note) => typeof note !== 'string' || !note.trim() || note.length > 1000)
    )
        throw new Error('The selected directional catalogue route limitations are unavailable or changed.');
    return detail.limitations.map((note) => `Catalogue ${constraint.direction} route limitation: ${note}`);
}
const validPoint = (point: Point) =>
    !!point &&
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 80 &&
    Number.isFinite(point.lon) &&
    Math.abs(point.lon) <= 180;
const distanceM = (a: Point, b: Point) => {
    const rad = Math.PI / 180;
    const h =
        Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
        Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 3440.065 * 1852 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
};

function checkpoints(constraint: CatalogueRouteConstraint): Point[] {
    if (
        !constraint ||
        !['outbound', 'return'].includes(constraint.direction) ||
        !Array.isArray(constraint.checkpoints) ||
        constraint.checkpoints.length < 2 ||
        constraint.checkpoints.length > 256 ||
        constraint.checkpoints.some(
            (point, index) => !validPoint(point) || point.sequence !== index + 1 || point.required !== true,
        )
    )
        throw new Error('The required catalogue checkpoints are invalid or unsupported.');
    return constraint.checkpoints;
}

/** Every required point remains an endpoint or an explicit provider mustGo.
 * The origin connector is retained when the yacht starts elsewhere. */
export function catalogueRouteMustGo(from: Point, to: Point, constraint: CatalogueRouteConstraint): Point[] {
    if (!validPoint(from) || !validPoint(to)) throw new Error('Catalogue route endpoints are invalid.');
    const required = checkpoints(constraint);
    const points = required.filter(
        (point, index) =>
            !(index === 0 && distanceM(from, point) < 1) &&
            !(index === required.length - 1 && distanceM(to, point) < 1),
    );
    if (points.length > CATALOGUE_MAX_REQUIRED_CHECKPOINTS)
        throw new Error(
            'This catalogue route exceeds the supported required-checkpoint budget; no checkpoints were omitted.',
        );
    if (
        points.some((point, index) =>
            [from, to, ...points.slice(0, index)].some((other) => distanceM(point, other) < 1),
        )
    )
        throw new Error('The required catalogue checkpoints cannot be represented as distinct provider constraints.');
    return points.map(({ lat, lon }) => ({ lat, lon }));
}

/** Check the actual provider path without changing it. A checkpoint must be
 * visited within 20 metres, in supplied travel order, including both endpoints.
 * Segment projection handles provider paths that omit a collinear vertex. */
export function assertCatalogueRouteCheckpoints(
    coordinates: readonly (readonly [number, number])[],
    constraint: CatalogueRouteConstraint,
): void {
    const required = checkpoints(constraint);
    if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        coordinates.length > AUTOROUTING_TRIAL_MAX_POINTS ||
        coordinates.some(
            (point, index) =>
                !Array.isArray(point) ||
                point.length !== 2 ||
                !validPoint({ lon: point[0], lat: point[1] }) ||
                (index > 0 && Math.abs(point[0] - coordinates[index - 1][0]) > 180),
        )
    )
        throw new Error('The catalogue route returned invalid or unsupported geometry.');
    let previous = 0;
    for (const checkpoint of required) {
        let found = false;
        const longitudeScale = Math.cos((checkpoint.lat * Math.PI) / 180);
        for (let index = Math.floor(previous); index < coordinates.length - 1; index++) {
            const a = coordinates[index],
                b = coordinates[index + 1];
            const dx = (b[0] - a[0]) * longitudeScale,
                dy = b[1] - a[1];
            const length2 = dx * dx + dy * dy;
            const projection = length2
                ? ((checkpoint.lon - a[0]) * longitudeScale * dx + (checkpoint.lat - a[1]) * dy) / length2
                : 0;
            const fraction = Math.max(
                index === Math.floor(previous) ? previous - index : 0,
                Math.min(1, Math.max(0, projection)),
            );
            const point = { lon: a[0] + (b[0] - a[0]) * fraction, lat: a[1] + dy * fraction };
            if (distanceM(point, checkpoint) <= 20) {
                previous = index + fraction;
                found = true;
                break;
            }
        }
        if (!found)
            throw new Error(
                'The route did not preserve every required catalogue checkpoint in order within 20 metres.',
            );
    }
}
