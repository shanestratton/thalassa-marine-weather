import { describe, expect, it } from 'vitest';
import {
    hasUsablePublicRoute,
    hasUsablePublicTrack,
    newestDiaryEntries,
    shouldDefaultToAllDiary,
} from '../src/publicDiaryDefaults';
import type { VoyageLogData, VoyageLogEntry } from '../src/voyageLogApi';

const data = {
    selected_trip: 'trip-one',
    trips: [
        { id: 'trip-one', kind: 'track', has_route: true },
        { id: 'all-diary', kind: 'all-diary' },
    ],
    // Deliberately a sailed track with no loaded planned route.
    track: [
        { lat: -27, lon: 153 },
        { lat: -26, lon: 153 },
    ],
    passage: null,
} as VoyageLogData;

describe('public diary first-load defaults', () => {
    it('keeps a just-recorded trip visible without a planned route', () => {
        expect(hasUsablePublicTrack(data)).toBe(true);
        expect(shouldDefaultToAllDiary(data)).toBe(false);
        expect(
            shouldDefaultToAllDiary({ ...data, trips: data.trips.map((trip) => ({ ...trip, has_route: false })) }),
        ).toBe(false);
    });

    it('defaults to all diary entries when neither a route nor recorded track exists', () => {
        expect(shouldDefaultToAllDiary({ ...data, track: [] })).toBe(true);
    });

    it.each([
        [],
        [{ lat: -27, lon: 153 }],
        [
            { lat: -27, lon: 153 },
            { lat: -27, lon: 153 },
        ],
        [
            { lat: -27, lon: 153 },
            { lat: 91, lon: 153 },
        ],
        [
            { lat: -27, lon: 153 },
            { lat: -26, lon: 181 },
        ],
        [
            { lat: -27, lon: 153 },
            { lat: Number.NaN, lon: 153 },
        ],
        [
            { lat: -27, lon: 153 },
            { lat: -26, lon: Infinity },
        ],
        [
            { lat: -27, lon: 153 },
            { lat: 0, lon: 0 },
        ],
    ])('does not use missing, stationary or invalid fixes as a sailed track: %j', (...track) => {
        const payload = { ...data, track: track as VoyageLogData['track'] };
        expect(hasUsablePublicTrack(payload)).toBe(false);
        expect(shouldDefaultToAllDiary(payload)).toBe(true);
    });

    it('recognises tracks in the whole-journey view without redirecting its selection', () => {
        const selected = { ...data, selected_trip: 'all-diary' };
        expect(hasUsablePublicTrack(selected)).toBe(true);
        expect(shouldDefaultToAllDiary(selected)).toBe(false);
    });

    it('does not treat two unrelated single-fix voyages as one sailed track', () => {
        expect(
            hasUsablePublicTrack({
                ...data,
                track: data.track.map((point, i) => ({
                    ...point,
                    voyage_id: `separate-${i}`,
                })),
            }),
        ).toBe(false);
    });

    it('keeps the routed-trip default when actual usable planned geometry exists', () => {
        const routed: VoyageLogData = {
            ...data,
            passage: {
                plan_line: [
                    [153, -27],
                    [154, -26],
                ],
            },
        };
        expect(hasUsablePublicRoute(routed)).toBe(true);
        expect(shouldDefaultToAllDiary(routed)).toBe(false);
    });

    it.each<{ planLine: [number, number][] }>([
        { planLine: [] },
        { planLine: [[153, -27]] },
        {
            planLine: [
                [153, -27],
                [153, -27],
            ],
        },
        {
            planLine: [
                [153, -27],
                [181, -26],
            ],
        },
        {
            planLine: [
                [153, -27],
                [154, -91],
            ],
        },
        {
            planLine: [
                [153, -27],
                [Number.NaN, -26],
            ],
        },
        {
            planLine: [
                [153, -27],
                [154, Number.POSITIVE_INFINITY],
            ],
        },
    ])('does not treat empty, degenerate or invalid geometry as a loaded route: $planLine', ({ planLine }) => {
        expect(hasUsablePublicRoute({ passage: { plan_line: planLine } })).toBe(false);
    });

    it('does not issue a redundant all-diary request when latest already includes it', () => {
        expect(shouldDefaultToAllDiary({ ...data, selected_trip: 'all-diary' })).toBe(false);
    });

    it('preserves compatibility with servers that do not offer all diary entries', () => {
        expect(shouldDefaultToAllDiary({ ...data, trips: [data.trips[0]] })).toBe(false);
    });
});

describe('public diary newest-first order', () => {
    it('sorts all entries by timestamp descending without changing the input or its entries', () => {
        const old = Object.freeze({ id: 'old', created_at: '2026-09-18T00:00:00Z' } as VoyageLogEntry);
        const newest = Object.freeze({ id: 'new', created_at: '2026-09-21T00:00:00Z' } as VoyageLogEntry);
        const middle = Object.freeze({ id: 'middle', created_at: '2026-09-20T00:00:00Z' } as VoyageLogEntry);
        const source = Object.freeze([old, newest, middle]);
        const result = newestDiaryEntries(source);
        expect(result).toEqual([newest, middle, old]);
        expect(source).toEqual([old, newest, middle]);
        expect(result[0]).toBe(newest);
    });

    it('uses immutable IDs to make tied dates deterministic and leaves unknown dates last', () => {
        const rows = [
            { id: 'z', created_at: 'invalid' },
            { id: 'b', created_at: '2026-09-20T00:00:00Z' },
            { id: 'a', created_at: '2026-09-20T00:00:00Z' },
            { id: 'y', created_at: '' },
        ] as VoyageLogEntry[];
        expect(newestDiaryEntries(rows).map((row) => row.id)).toEqual(['a', 'b', 'y', 'z']);
        expect(newestDiaryEntries([...rows].reverse()).map((row) => row.id)).toEqual(['a', 'b', 'y', 'z']);
    });
});
