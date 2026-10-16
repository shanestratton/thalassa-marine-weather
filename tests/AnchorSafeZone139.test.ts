import { describe, expect, it } from 'vitest';
import {
    anchorSafeZoneContains,
    anchorZoneOffset,
    anchorZonePosition,
    parseAnchorSafeZone,
    type AnchorZoneFrame,
} from '../utils/anchorSafeZone';

const frame: AnchorZoneFrame = { latitude: -27, longitude: 153, radiusM: 100 };
const at = (east: number, north: number, f = frame) => anchorZonePosition(f, east, north)!;
const polygon = (coordinates: number[][], f = frame) => ({
    version: 1,
    kind: 'polygon',
    anchor: { latitude: f.latitude, longitude: f.longitude },
    vertices: coordinates.map(([e, n]) => at(e, n, f)),
});
const square = (f = frame) =>
    polygon(
        [
            [-50, -50],
            [50, -50],
            [50, 50],
            [-50, 50],
        ],
        f,
    );
const wedges = (exclusions = [{ startDeg: 350, sweepDeg: 20 }]) => ({
    version: 1,
    kind: 'wedges',
    anchor: { latitude: frame.latitude, longitude: frame.longitude },
    exclusions,
});
const bearingAt = (bearing: number, distance = 50) =>
    at(Math.sin((bearing * Math.PI) / 180) * distance, Math.cos((bearing * Math.PI) / 180) * distance);

describe('manual anchor safe-area geometry', () => {
    it.each([
        frame,
        { latitude: 0, longitude: 179.9999, radiusM: 100 },
        { latitude: 89.99, longitude: -179.9999, radiusM: 100 },
        { latitude: 90, longitude: 23, radiusM: 100 },
        { latitude: -90, longitude: -179, radiusM: 100 },
    ])('round trips and watches the small local area at $latitude,$longitude', (f) => {
        const p = anchorZonePosition(f, 15, -25)!;
        const offset = anchorZoneOffset(f, p)!;
        expect(offset[0]).toBeCloseTo(15, 4);
        expect(offset[1]).toBeCloseTo(-25, 4);
        expect(parseAnchorSafeZone(square(f), f).ok).toBe(true);
        expect(anchorSafeZoneContains(square(f), f, p)).toBe(true);
        expect(anchorSafeZoneContains(square(f), f, at(60, 0, f))).toBe(false);
    });
    it('keeps polygon edges in the safe area and the native circle outside it', () => {
        expect(anchorSafeZoneContains(square(), frame, at(50, 0))).toBe(true);
        expect(anchorSafeZoneContains(square(), frame, at(50.1, 0))).toBe(false);
        expect(anchorSafeZoneContains(square(), frame, at(100.1, 0))).toBe(false);
    });
    it.each([0, 350, 10])('excludes the north-wrapping wedge including its boundary at %s true', (bearing) => {
        expect(anchorSafeZoneContains(wedges(), frame, bearingAt(bearing))).toBe(false);
    });
    it.each([11, 90, 180, 349])('keeps the remaining circle at %s true', (bearing) => {
        expect(anchorSafeZoneContains(wedges(), frame, bearingAt(bearing))).toBe(true);
    });
    it('does not invent a bearing for the anchor itself', () =>
        expect(anchorSafeZoneContains(wedges(), frame, frame)).toBe(true));
    it('does not count overlap twice and refuses complete exclusion', () => {
        expect(
            parseAnchorSafeZone(
                wedges([
                    { startDeg: 0, sweepDeg: 120 },
                    { startDeg: 90, sweepDeg: 120 },
                ]),
                frame,
            ).ok,
        ).toBe(true);
        expect(
            parseAnchorSafeZone(
                wedges([
                    { startDeg: 0, sweepDeg: 180 },
                    { startDeg: 180, sweepDeg: 180 },
                ]),
                frame,
            ).ok,
        ).toBe(false);
    });
    it.each(
        [
            [
                [-50, -50],
                [50, 50],
                [-50, 50],
                [50, -50],
            ],
            [
                [-50, -50],
                [50, -50],
                [0, -50],
                [50, 50],
                [-50, 50],
            ],
            [
                [-50, -50],
                [50, -50],
                [50, -50],
                [-50, 50],
            ],
            [
                [-50, -50],
                [50, -50],
                [50, 50],
                [-50, -50],
            ],
            [
                [1, 1],
                [2, 1],
                [2, 2],
            ],
            [
                [-80, -80],
                [80, -80],
                [80, 80],
                [-80, 80],
            ],
            [
                [20, 20],
                [40, 20],
                [40, 40],
                [20, 40],
            ],
        ].map((coordinates) => ({ coordinates })),
    )('refuses a crossed, doubled, degenerate, oversized or displaced polygon $coordinates', ({ coordinates }) => {
        expect(parseAnchorSafeZone(polygon(coordinates), frame).ok).toBe(false);
    });
    it('never clips a recovered polygon to a reduced native circle', () =>
        expect(parseAnchorSafeZone(square(), { ...frame, radiusM: 60 }).ok).toBe(false));
    it('retires old geometry when the anchor moves', () =>
        expect(parseAnchorSafeZone(square(), { ...at(2, 0), radiusM: 100 }).ok).toBe(false));
    it('requires an explicit review of unsupported holes or future fields', () => {
        expect(parseAnchorSafeZone({ ...square(), holes: [] }, frame).ok).toBe(false);
        expect(parseAnchorSafeZone({ ...wedges(), vertices: [] }, frame).ok).toBe(false);
    });
    it.each([
        null,
        {},
        { version: 2 },
        { ...square(), vertices: Array(65).fill(frame) },
        { ...square(), vertices: [frame, frame, frame] },
        { ...wedges(), exclusions: Array(9).fill({ startDeg: 0, sweepDeg: 1 }) },
        { ...wedges(), exclusions: [{ startDeg: -1, sweepDeg: 20 }] },
        { ...wedges(), exclusions: [{ startDeg: 0, sweepDeg: 360 }] },
        { ...wedges(), exclusions: [{ startDeg: 0, sweepDeg: NaN }] },
    ])('refuses malformed or unbounded input %j', (value) => expect(parseAnchorSafeZone(value, frame).ok).toBe(false));
    it('copies and freezes admitted manual points across JSON recovery', () => {
        const raw = square();
        const admitted = parseAnchorSafeZone(JSON.parse(JSON.stringify(raw)), frame);
        expect(admitted.ok).toBe(true);
        if (!admitted.ok || admitted.zone.kind !== 'polygon') throw Error('Fixture refused');
        raw.vertices[0].latitude = 80;
        expect(Object.isFrozen(admitted.zone)).toBe(true);
        expect(Object.isFrozen(admitted.zone.vertices)).toBe(true);
        expect(Object.isFrozen(admitted.zone.vertices[0])).toBe(true);
        expect(anchorSafeZoneContains(admitted.zone, frame, frame)).toBe(true);
    });
    it('reports invalid fixes or geometry as unknown, never holding', () => {
        expect(anchorSafeZoneContains(square(), frame, { latitude: NaN, longitude: 0 })).toBeNull();
        expect(anchorSafeZoneContains({ version: 8 }, frame, frame)).toBeNull();
        expect(parseAnchorSafeZone(square(), { ...frame, radiusM: Infinity }).ok).toBe(false);
        expect(anchorZoneOffset(frame, { latitude: 27, longitude: -27 })).toBeNull();
        expect(anchorZonePosition(frame, 6000, 0)).toBeNull();
    });
});
