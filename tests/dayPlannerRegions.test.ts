import { describe, expect, it, vi } from 'vitest';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';
import {
    DAY_PLANNER_REGIONS,
    WHITSUNDAYS_DAY_PLANNER_REGION,
    coveredRegionNames,
    findDayPlannerRegion,
    resolvePlanningArea,
    validateDayPlannerRegions,
    type DayPlannerRegion,
} from '../services/dayPlanner/regions';

function syntheticRegion(id = 'test-region'): DayPlannerRegion {
    return {
        ...structuredClone(WHITSUNDAYS_DAY_PLANNER_REGION),
        id,
        name: 'Synthetic test region',
        timeZone: 'Etc/UTC',
        bounds: { west: -1, south: -1, east: 1, north: 1 },
        reference: { center: { lat: 0, lon: 0 }, radiusNM: 100, dataset: 'qld' },
        destinations: [
            {
                ...structuredClone(WHITSUNDAYS_DAY_DESTINATIONS[0]),
                id: `${id}-stop`,
                anchorageId: `${id}-anchor`,
                lat: 0,
                lon: 0,
                timeZone: 'Etc/UTC',
            },
        ],
    };
}

describe('reviewed day-planner region registry', () => {
    it('ships only the existing reviewed pack without moving or cloning its source references', () => {
        expect(DAY_PLANNER_REGIONS).toEqual([WHITSUNDAYS_DAY_PLANNER_REGION]);
        expect(WHITSUNDAYS_DAY_PLANNER_REGION.destinations).toBe(WHITSUNDAYS_DAY_DESTINATIONS);
        expect(WHITSUNDAYS_DAY_PLANNER_REGION.reference).toEqual({
            center: { lat: -20.2, lon: 148.95 },
            radiusNM: 35,
            dataset: 'qld',
        });
        expect(coveredRegionNames()).toEqual(['Whitsundays']);
        expect(() => validateDayPlannerRegions(DAY_PLANNER_REGIONS)).not.toThrow();
        expect(
            DAY_PLANNER_REGIONS[0].destinations.every(
                (destination) =>
                    destination.catalogueQuality === 'reviewed' && destination.timeZone === 'Australia/Brisbane',
            ),
        ).toBe(true);
    });

    it('uses inclusive geographic coverage rather than the nearest reviewed destination', () => {
        expect(findDayPlannerRegion({ lat: -20.2, lon: 148.99 })).toBe(WHITSUNDAYS_DAY_PLANNER_REGION);
        expect(findDayPlannerRegion({ lat: -21, lon: 148.4 })).toBe(WHITSUNDAYS_DAY_PLANNER_REGION);
        expect(findDayPlannerRegion({ lat: -19.5, lon: 149.5 })).toBe(WHITSUNDAYS_DAY_PLANNER_REGION);
        expect(findDayPlannerRegion({ lat: -21.0001, lon: 148.4 })).toBeUndefined();
        expect(findDayPlannerRegion({ lat: 38.9, lon: 1.4 })).toBeUndefined();
        expect(findDayPlannerRegion({ lat: 0, lon: 0 }, [])).toBeUndefined();
    });

    it('supports date-line-crossing bounds and equivalent ±180 boundary coordinates', () => {
        const region = syntheticRegion();
        region.bounds = { west: 179, south: -1, east: -179, north: 1 };
        region.reference.center.lon = 180;
        region.destinations[0].lon = -179.9;
        for (const lon of [179, 179.5, 180, -180, -179.5, -179])
            expect(findDayPlannerRegion({ lat: 0, lon }, [region])).toBe(region);
        expect(findDayPlannerRegion({ lat: 0, lon: 0 }, [region])).toBeUndefined();
        expect(findDayPlannerRegion({ lat: 0, lon: 178.999 }, [region])).toBeUndefined();
        region.bounds = { west: 179, south: -1, east: 180, north: 1 };
        region.destinations[0].lon = 180;
        expect(findDayPlannerRegion({ lat: 0, lon: -180 }, [region])).toBe(region);
    });

    it('rejects ambiguous overlap independently of registry order, including a shared boundary', () => {
        const west = syntheticRegion('west');
        const east = syntheticRegion('east');
        expect(() => findDayPlannerRegion({ lat: 0, lon: 0 }, [west, east])).toThrow(/overlap/);
        expect(() => findDayPlannerRegion({ lat: 0, lon: 0 }, [east, west])).toThrow(/overlap/);
        east.bounds = { ...east.bounds, west: 1, east: 3 };
        east.reference.center.lon = 2;
        east.destinations[0].lon = 2;
        expect(() => findDayPlannerRegion({ lat: 0, lon: 1 }, [west, east])).toThrow(/overlap/);
        expect(findDayPlannerRegion({ lat: 0, lon: 0.5 }, [west, east])).toBe(west);
    });

    it.each([
        [
            'invalid region id',
            (r: DayPlannerRegion) => {
                r.id = 'not a stable id';
            },
        ],
        [
            'empty label',
            (r: DayPlannerRegion) => {
                r.name = '';
            },
        ],
        [
            'invalid zone',
            (r: DayPlannerRegion) => {
                r.timeZone = 'Invalid/Zone';
            },
        ],
        [
            'numeric offset instead of zone',
            (r: DayPlannerRegion) => {
                r.timeZone = '+10:00';
            },
        ],
        [
            'nonfinite bounds',
            (r: DayPlannerRegion) => {
                r.bounds.west = NaN;
            },
        ],
        [
            'zero-width bounds',
            (r: DayPlannerRegion) => {
                r.bounds.west = r.bounds.east;
            },
        ],
        [
            'reversed latitude bounds',
            (r: DayPlannerRegion) => {
                r.bounds.north = -2;
            },
        ],
        [
            'center outside region',
            (r: DayPlannerRegion) => {
                r.reference.center.lat = 3;
            },
        ],
        [
            'unbounded query radius',
            (r: DayPlannerRegion) => {
                r.reference.radiusNM = 101;
            },
        ],
        [
            'missing attribution',
            (r: DayPlannerRegion) => {
                r.sourceAttributions = [];
            },
        ],
        [
            'no reviewed stops',
            (r: DayPlannerRegion) => {
                r.destinations = [];
            },
        ],
        [
            'mapped reference masquerading as reviewed',
            (r: DayPlannerRegion) => {
                r.destinations[0].catalogueQuality = 'mapped-reference';
            },
        ],
        [
            'missing fact-review date',
            (r: DayPlannerRegion) => {
                delete r.destinations[0].verifiedAt;
            },
        ],
        [
            'impossible fact-review date',
            (r: DayPlannerRegion) => {
                r.destinations[0].verifiedAt = '2026-02-30';
            },
        ],
        [
            'candidate outside region',
            (r: DayPlannerRegion) => {
                r.destinations[0].lat = 2;
            },
        ],
        [
            'candidate outside query radius',
            (r: DayPlannerRegion) => {
                r.reference.radiusNM = 0.1;
                r.destinations[0].lat = 0.1;
            },
        ],
        [
            'invalid candidate zone',
            (r: DayPlannerRegion) => {
                r.destinations[0].timeZone = 'Invalid/Zone';
            },
        ],
        [
            'missing exact source identity',
            (r: DayPlannerRegion) => {
                r.destinations[0].anchorageId = '';
            },
        ],
        [
            'missing source label',
            (r: DayPlannerRegion) => {
                r.destinations[0].sourceLabel = '';
            },
        ],
        [
            'unsafe source link',
            (r: DayPlannerRegion) => {
                r.destinations[0].sourceUrl = 'javascript:alert(1)';
            },
        ],
        [
            'no access caveats',
            (r: DayPlannerRegion) => {
                r.destinations[0].accessNotes = [];
            },
        ],
        [
            'no uncertainty caveats',
            (r: DayPlannerRegion) => {
                r.destinations[0].uncertaintyNotes = [];
            },
        ],
        [
            'invalid closure dates',
            (r: DayPlannerRegion) => {
                r.destinations[0].knownClosures = [
                    {
                        fromDate: '2026-11-02',
                        throughDate: '2026-11-01',
                        reason: 'Test closure',
                        sourceUrl: 'https://example.com/notice',
                    },
                ];
            },
        ],
    ] as const)('fails closed for %s, even when the queried departure is elsewhere', (_name, mutate) => {
        const region = syntheticRegion();
        mutate(region);
        expect(() => findDayPlannerRegion({ lat: 45, lon: 20 }, [region])).toThrow(/metadata/);
    });

    it.each(['region', 'destination', 'anchorage'] as const)('rejects duplicate %s identity', (identity) => {
        const one = syntheticRegion('one');
        const two = syntheticRegion('two');
        if (identity === 'region') two.id = one.id;
        else if (identity === 'destination') two.destinations[0].id = one.destinations[0].id;
        else two.destinations[0].anchorageId = one.destinations[0].anchorageId;
        expect(() => validateDayPlannerRegions([one, two])).toThrow(/metadata/);
    });
});

describe('synchronous day-planning area context', () => {
    it('labels reviewed coverage and resolves an unreviewed origin zone without promising coverage', () => {
        expect(resolvePlanningArea({ lat: -20.2, lon: 148.99 })).toEqual({
            id: 'whitsundays',
            name: 'Whitsundays',
            timeZone: 'Australia/Brisbane',
            coverage: 'reviewed',
            region: WHITSUNDAYS_DAY_PLANNER_REGION,
        });
        vi.stubEnv('TZ', 'Australia/Brisbane');
        try {
            expect(resolvePlanningArea({ lat: 40.7, lon: -74 })).toEqual({
                id: 'mapped-reference',
                name: 'Nearby mapped anchorages',
                timeZone: 'America/New_York',
                coverage: 'mapped-reference',
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it.each([
        { lat: NaN, lon: 0 },
        { lat: 91, lon: 0 },
        { lat: 0, lon: 181 },
        { lat: 0, lon: Infinity },
    ])('rejects invalid departure %j instead of inventing a zone or nearest pack', (point) => {
        expect(() => resolvePlanningArea(point)).toThrow(/valid departure/);
    });

    it('does not turn ambiguous reviewed coverage into a mapped fallback', () => {
        expect(() => resolvePlanningArea({ lat: 0, lon: 0 }, [syntheticRegion('one'), syntheticRegion('two')])).toThrow(
            /overlap/,
        );
    });
});
