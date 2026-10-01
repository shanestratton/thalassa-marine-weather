/**
 * What a route says about its canal and marina water (Phase 2b, 2026-10-01).
 *
 * Owner decision 2: offline, the Newport canal routes WHEN its water is in the
 * phone's pack, and says "no route" — and why — when it is not. A route that
 * used the pack or the Pi's stale copy says so, with the date and the
 * © OpenStreetMap contributors credit (ODbL). Persisted words carry absolute
 * dates only: a saved plan's "3 days ago" would go false.
 */
import { describe, expect, it } from 'vitest';
import {
    applyWaterPack,
    waterPackCaveats,
    waterPackUseFor,
    type WaterPackUse,
} from '../../services/waterPack/waterPackWords';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 1, 21).getTime();
const SAVED = new Date(2026, 8, 28, 12).getTime();
const NEWPORT = { lat: -27.2127, lon: 153.0912 };
const SCARBOROUGH = { lat: -27.4442, lon: 153.1046 };

describe('waterPackUseFor', () => {
    it('no provenance (a mocked overlay, an old caller) → no words at all', () => {
        expect(waterPackUseFor(undefined, NEWPORT, SCARBOROUGH)).toBeUndefined();
    });

    it('online sources and the Pi stale copy miss nothing', () => {
        for (const source of ['pi', 'cloud', 'pi-legacy'] as const)
            expect(waterPackUseFor({ source, coverage: 'full' }, NEWPORT, SCARBOROUGH)).toEqual({
                source: 'online',
                missing: [],
            });
        expect(
            waterPackUseFor({ source: 'pi-stale', coverage: 'full', dataAsOf: SAVED }, NEWPORT, SCARBOROUGH),
        ).toEqual({
            source: 'pi-stale',
            dataAsOf: SAVED,
            missing: [],
        });
    });

    it("the pack misses an end whose area tiles aren't all saved", () => {
        const use = waterPackUseFor(
            { source: 'pack', coverage: 'partial', dataAsOf: SAVED, presentTiles: ['3061_-545', '3062_-545'] },
            NEWPORT,
            SCARBOROUGH,
        );
        expect(use).toEqual({ source: 'pack', dataAsOf: SAVED, missing: ['destination'] });
        expect(waterPackUseFor({ source: 'none', coverage: 'none', presentTiles: [] }, NEWPORT, SCARBOROUGH)).toEqual({
            source: 'none',
            missing: ['departure', 'destination'],
        });
    });

    // Fix-up (2026-10-02).
    it('carries whether the phone was offline, for the advice the words give', () => {
        expect(
            waterPackUseFor(
                { source: 'none', coverage: 'none', presentTiles: [], offline: true },
                NEWPORT,
                SCARBOROUGH,
            ),
        ).toEqual({ source: 'none', missing: ['departure', 'destination'], offline: true });
    });

    it("an end is missing when water within ~2 km of its pin was left out for a tile that isn't saved", () => {
        const present = ['3061_-545', '3062_-545', '3062_-549'];
        // The pin's own tile is saved, but the basin it sits in reaches the
        // next tile west, which is not: the pack dropped it.
        const nearPin: [number, number, number, number] = [153.045, -27.22, 153.095, -27.205];
        const use = waterPackUseFor(
            { source: 'pack', coverage: 'partial', presentTiles: present, unsavedWater: [nearPin] },
            NEWPORT,
            { lat: -27.425, lon: 153.125 },
        );
        expect(use?.missing).toEqual(['departure']);
        // Dropped water far from both pins: no end is missing, but the route
        // has a gap a refusal must explain.
        const far: [number, number, number, number] = [153.11, -27.36, 153.14, -27.33];
        expect(
            waterPackUseFor(
                { source: 'pack', coverage: 'partial', presentTiles: present, unsavedWater: [far] },
                NEWPORT,
                { lat: -27.425, lon: 153.125 },
            ),
        ).toEqual({ source: 'pack', missing: [], gaps: true });
    });
});

describe('waterPackCaveats', () => {
    it('the pack: the absolute date and the OSM credit', () => {
        expect(waterPackCaveats({ source: 'pack', dataAsOf: SAVED, missing: [] }, NOW)).toEqual([
            'Canal and marina water on this route came from the harbour water saved on this phone on 28 Sep (© OpenStreetMap contributors), not a live download. Check it against the chart.',
        ]);
    });

    it('adds the 3-month line only past 90 days', () => {
        expect(waterPackCaveats({ source: 'pack', dataAsOf: NOW - 89 * DAY, missing: [] }, NOW)[0]).not.toMatch(
            /over 3 months old/,
        );
        expect(waterPackCaveats({ source: 'pack', dataAsOf: NOW - 91 * DAY, missing: [] }, NOW)[0]).toMatch(
            / It is over 3 months old; the marina may have changed since\.$/,
        );
    });

    it("the Pi's stale copy", () => {
        expect(waterPackCaveats({ source: 'pi-stale', dataAsOf: SAVED, missing: [] }, NOW)).toEqual([
            "Canal and marina water came from the boat's Pi, saved 28 Sep (© OpenStreetMap contributors); it couldn't be refreshed. Check it against the chart.",
        ]);
    });

    it('a routed end with no saved water says it was routed on the charts alone', () => {
        expect(
            waterPackCaveats({ source: 'pack', dataAsOf: SAVED, missing: ['destination'], offline: true }, NOW),
        ).toContain(
            "Harbour water for the destination isn't saved on this phone, so that end was routed on the charts alone.",
        );
        expect(waterPackCaveats({ source: 'none', missing: ['departure', 'destination'], offline: true }, NOW)).toEqual(
            [
                "Harbour water for the departure and the destination isn't saved on this phone, so both ends were routed on the charts alone.",
            ],
        );
    });

    // Fix-up (2026-10-02): 'none' also happens online — the cloud at its
    // quota, a 503, a signed-out phone with no Pi. Those words never tell an
    // online skipper to get online.
    it('online, a routed end says its water could not be downloaded', () => {
        expect(waterPackCaveats({ source: 'none', missing: ['departure', 'destination'] }, NOW)).toEqual([
            "Harbour water for the departure and the destination couldn't be downloaded and isn't saved on this phone, so both ends were routed on the charts alone.",
        ]);
        expect(waterPackCaveats({ source: 'pack', dataAsOf: SAVED, missing: ['destination'] }, NOW)[1]).toBe(
            "Harbour water for the destination couldn't be downloaded and isn't saved on this phone, so that end was routed on the charts alone.",
        );
    });

    it('online: nothing to say; undefined: nothing to say', () => {
        expect(waterPackCaveats({ source: 'online', missing: [] }, NOW)).toEqual([]);
        expect(waterPackCaveats(undefined, NOW)).toEqual([]);
    });
});

describe('applyWaterPack', () => {
    const offline: WaterPackUse = { source: 'none', missing: ['departure', 'destination'], offline: true };
    const engine = 'No safe chart-vouched route: the only candidate crosses 0.9 km of charted land';

    it('a success carries its use, unchanged otherwise', () => {
        const ok = { polyline: [[153, -27]] as [number, number][], distanceNM: 1, cellsUsed: [], elapsedMs: 1 };
        expect(applyWaterPack(ok, { source: 'pack', dataAsOf: SAVED, missing: [] })).toEqual({
            ...ok,
            waterPack: { source: 'pack', dataAsOf: SAVED, missing: [] },
        });
        expect(applyWaterPack(ok, undefined)).toBe(ok);
        expect(applyWaterPack(null, offline)).toBeNull();
    });

    it("a land refusal leads with the pack: no route, the harbour water isn't on this phone yet", () => {
        const res = applyWaterPack({ error: engine, code: 'hard-land-crossing' }, offline);
        expect(res.code).toBe('hard-land-crossing');
        expect(res.error).toBe(
            `No route: the harbour water for the departure and the destination isn't on this phone yet, and the charts alone may show that water as land. Route once you're online to save it. (${engine})`,
        );
        const one = applyWaterPack(
            { error: engine, code: 'origin-on-land' },
            { source: 'pack', missing: ['departure'], offline: true },
        );
        expect(one.error.startsWith("No route: the harbour water for the departure isn't on this phone yet")).toBe(
            true,
        );
    });

    it('a named refusal keeps its own words first and appends the pack', () => {
        for (const code of ['no-tide-clears', 'air-draft-blocked', 'coverage-gap']) {
            const res = applyWaterPack(
                { error: 'The engine says why.', code },
                { source: 'pack', missing: ['departure'], offline: true },
            );
            expect(res.error).toBe(
                "The engine says why. The harbour water for the departure isn't on this phone yet either; route once you're online to save it.",
            );
            expect(res.code).toBe(code);
        }
    });

    // Fix-up (2026-10-02).
    it('the watchdog: its words get a full stop, and no "either" after a timeout', () => {
        const res = applyWaterPack(
            {
                error: 'Inshore routing timed out — check signal and chart sync, then try again',
                code: 'watchdog-timeout',
            },
            { source: 'pack', missing: ['departure'], offline: true },
        );
        expect(res.error).toBe(
            "Inshore routing timed out — check signal and chart sync, then try again. The harbour water for the departure isn't on this phone yet; route once you're online to save it.",
        );
        expect(res.code).toBe('watchdog-timeout');
    });

    it('online, the advice is to try again shortly — never to get online', () => {
        const online: WaterPackUse = { source: 'none', missing: ['departure', 'destination'] };
        expect(applyWaterPack({ error: engine, code: 'hard-land-crossing' }, online).error).toBe(
            `No route: the harbour water for the departure and the destination couldn't be downloaded just now and isn't saved on this phone, and the charts alone may show that water as land. Try again shortly. (${engine})`,
        );
        expect(applyWaterPack({ error: 'No tide clears it.', code: 'no-tide-clears' }, online).error).toBe(
            "No tide clears it. The harbour water for the departure and the destination couldn't be downloaded just now either; try again shortly.",
        );
        expect(
            applyWaterPack(
                {
                    error: 'Inshore routing timed out — check signal and chart sync, then try again',
                    code: 'watchdog-timeout',
                },
                online,
            ).error,
        ).toBe(
            "Inshore routing timed out — check signal and chart sync, then try again. The harbour water for the departure and the destination couldn't be downloaded just now; try again shortly.",
        );
    });

    it('a land refusal on a partial pack with both ends saved says some water along the route is not saved', () => {
        const gaps: WaterPackUse = { source: 'pack', dataAsOf: SAVED, missing: [], gaps: true, offline: true };
        expect(applyWaterPack({ error: engine, code: 'hard-land-crossing' }, gaps).error).toBe(
            `${engine}. Some harbour water along this route isn't saved on this phone, so the charts alone were used there; route once you're online to save it.`,
        );
        expect(
            applyWaterPack({ error: engine, code: 'hard-land-crossing' }, { ...gaps, offline: undefined }).error,
        ).toBe(
            `${engine}. Some harbour water along this route couldn't be downloaded just now and isn't saved on this phone, so the charts alone were used there; try again shortly.`,
        );
        // A named refusal has nothing to do with the canal water.
        expect(applyWaterPack({ error: 'No tide clears it.', code: 'no-tide-clears' }, gaps).error).toBe(
            'No tide clears it.',
        );
    });

    it('online, or with both ends saved, a refusal keeps the engine words exactly', () => {
        const online = applyWaterPack({ error: engine, code: 'hard-land-crossing' }, { source: 'online', missing: [] });
        expect(online.error).toBe(engine);
        const stale = applyWaterPack(
            { error: engine, code: 'hard-land-crossing' },
            { source: 'pi-stale', dataAsOf: SAVED, missing: [] },
        );
        expect(stale.error).toBe(engine);
        expect(stale.waterPack).toEqual({ source: 'pi-stale', dataAsOf: SAVED, missing: [] });
    });
});
