/**
 * anchorageVerdict — the "which anchorage tonight" engine.
 *
 * The Nara Inlet table below is REAL — cast by build-qld.mjs against OSM
 * coastline on 2026-08-25: essentially landlocked with one narrow opening
 * to the SSW (sector 20 ≈ 200°, 13.2 NM). If the engine can't tell Nara
 * from an open roadstead, it can't tell a skipper anything.
 */
import { describe, expect, it } from 'vitest';
import {
    fetchAt,
    rankAnchorages,
    scoreAnchorage,
    worstFetchAround,
    type AnchorageForVerdict,
    type VerdictHour,
} from '../services/anchorages/anchorageVerdict';

// Real build output (Nara Inlet, Hook Island).
const NARA_LAND = [
    0.5, 0.8, 0.5, 0.3, 0.2, 0.2, 0.3, 0.3, 0.4, 0.2, 0.1, 0.2, 0.2, 0.2, 0.1, 0.1, 0.2, 0.3, 0.4, 0.8, 13.2, 8.6, 0.8,
    0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.3,
];

const mk = (over: Partial<AnchorageForVerdict> = {}): AnchorageForVerdict => ({
    id: 'a1',
    name: 'Test Bay',
    kind: 'anchorage',
    lat: -20.14,
    lon: 148.9,
    fetchLandNM: NARA_LAND,
    fetchReefNM: NARA_LAND,
    ...over,
});

const OPEN_TABLE = new Array(36).fill(15);
/** Open to the east (040–140°), sheltered elsewhere — a west-coast bay. */
const EAST_OPEN = new Array(36).fill(0.4).map((v, i) => (i >= 4 && i <= 14 ? 15 : v));

const hoursOf = (
    spec: Array<{ dir: number; kts: number; swellDir?: number; swellM?: number; periodS?: number }>,
): VerdictHour[] =>
    spec.map((s, i) => ({
        t: Date.UTC(2026, 7, 25, 8) + i * 3_600_000,
        windDirDeg: s.dir,
        windKts: s.kts,
        swellDirDeg: s.swellDir,
        swellM: s.swellM,
        swellPeriodS: s.periodS,
    }));

describe('fetch table reads', () => {
    it('interpolates between sectors', () => {
        expect(fetchAt(NARA_LAND, 200)).toBe(13.2);
        expect(fetchAt(NARA_LAND, 205)).toBeCloseTo((13.2 + 8.6) / 2, 5);
        expect(fetchAt(NARA_LAND, 0)).toBe(0.5);
    });
    it('worstFetchAround finds the gap a plain read misses', () => {
        // Swell from due S (180°) with 40° wrap must find the 200° opening.
        expect(fetchAt(NARA_LAND, 180)).toBeLessThan(1);
        expect(worstFetchAround(NARA_LAND, 180, 40)).toBe(13.2);
    });
});

describe('scoreAnchorage', () => {
    it('calls Nara Inlet bombproof in a 25 kn SE blow', () => {
        const v = scoreAnchorage({
            anchorage: mk({ name: 'Nara Inlet' }),
            hours: hoursOf(
                Array.from({ length: 12 }, () => ({ dir: 135, kts: 25, swellDir: 140, swellM: 1.8, periodS: 9 })),
            ),
        });
        expect(v.grade).toBe('bombproof');
        expect(v.score).toBeGreaterThan(85);
        expect(v.swellUnknown).toBe(false);
    });

    it('calls an open roadstead poor in the same blow — and says why', () => {
        const v = scoreAnchorage({
            anchorage: mk({ name: 'Open Roadstead', fetchLandNM: OPEN_TABLE, fetchReefNM: OPEN_TABLE }),
            hours: hoursOf(
                Array.from({ length: 12 }, () => ({ dir: 135, kts: 25, swellDir: 140, swellM: 1.8, periodS: 9 })),
            ),
        });
        expect(v.grade).toBe('poor');
        expect(v.reasons.join(' ')).toMatch(/Open to the SE/);
    });

    it('the 02:00 shift dominates: a calm evening cannot buy back a rotten night', () => {
        // East-open bay: glassy in the SW evening breeze, ugly when it swings E.
        const evening = Array.from({ length: 6 }, () => ({ dir: 225, kts: 10 }));
        const shift = Array.from({ length: 4 }, () => ({ dir: 90, kts: 22 }));
        const v = scoreAnchorage({
            anchorage: mk({ fetchLandNM: EAST_OPEN, fetchReefNM: EAST_OPEN }),
            hours: hoursOf([...evening, ...shift]),
        });
        expect(v.grade === 'poor' || v.grade === 'tenable').toBe(true);
        expect(v.worstAtMs).not.toBeNull();
        // The worst hour is in the shift, not the evening.
        const worstIndex = hoursOf([...evening, ...shift]).findIndex((h) => h.t === v.worstAtMs);
        expect(worstIndex).toBeGreaterThanOrEqual(6);
    });

    it('a reef lee kills the chop but a lee is not a calm: grade rests on the reef table', () => {
        // Land wide open, reef 0.5 NM upwind — designated GBR anchorage shape.
        const reefLee = { fetchLandNM: OPEN_TABLE, fetchReefNM: new Array(36).fill(0.5) };
        const v = scoreAnchorage({
            anchorage: mk(reefLee),
            hours: hoursOf(
                Array.from({ length: 8 }, () => ({ dir: 120, kts: 25, swellDir: 130, swellM: 2, periodS: 10 })),
            ),
        });
        expect(v.grade).toBe('bombproof');
    });

    it('missing swell is REPORTED, never scored as calm', () => {
        const v = scoreAnchorage({
            anchorage: mk(),
            hours: hoursOf(Array.from({ length: 6 }, () => ({ dir: 135, kts: 15 }))),
        });
        expect(v.swellUnknown).toBe(true);
        expect(v.reasons.join(' ')).toMatch(/Swell unknown/);
    });

    it('no-anchoring pins the bottom regardless of shelter', () => {
        const v = scoreAnchorage({
            anchorage: mk({ noAnchoring: true, noAnchoringName: 'Butterfly Bay Reef' }),
            hours: hoursOf([{ dir: 135, kts: 5 }]),
        });
        expect(v.grade).toBe('no-anchoring');
        expect(v.score).toBe(0);
        expect(v.reasons[0]).toMatch(/Butterfly Bay Reef/);
    });

    it('says "models split" when models disagree past the thresholds — the honesty clause', () => {
        const hours = hoursOf(Array.from({ length: 4 }, () => ({ dir: 135, kts: 18 })));
        const v = scoreAnchorage({
            anchorage: mk(),
            hours,
            perModelWinds: [
                hours.map(() => ({ windDirDeg: 135, windKts: 12 })),
                hours.map(() => ({ windDirDeg: 135, windKts: 28 })), // ECMWF 12 vs UKMO 28 — the Newport split
            ],
        });
        expect(v.modelsSplit).toBe(true);
        expect(v.reasons.join(' ')).toMatch(/Models split/);
    });

    it('agreement does not cry wolf', () => {
        const hours = hoursOf(Array.from({ length: 4 }, () => ({ dir: 135, kts: 18 })));
        const v = scoreAnchorage({
            anchorage: mk(),
            hours,
            perModelWinds: [
                hours.map(() => ({ windDirDeg: 130, windKts: 17 })),
                hours.map(() => ({ windDirDeg: 140, windKts: 20 })),
            ],
        });
        expect(v.modelsSplit).toBe(false);
    });
});

describe('rankAnchorages — the "where tonight" list', () => {
    it('ranks shelter first and sinks no-anchoring to the bottom', () => {
        const hours = hoursOf(
            Array.from({ length: 8 }, () => ({ dir: 135, kts: 20, swellDir: 140, swellM: 1.5, periodS: 9 })),
        );
        const ranked = rankAnchorages(
            [
                mk({ id: 'open', name: 'Open Roadstead', fetchLandNM: OPEN_TABLE, fetchReefNM: OPEN_TABLE }),
                mk({ id: 'nara', name: 'Nara Inlet' }),
                mk({ id: 'illegal', name: 'Pretty But Illegal', noAnchoring: true }),
                mk({ id: 'east', name: 'East-Open Bay', fetchLandNM: EAST_OPEN, fetchReefNM: EAST_OPEN }),
            ],
            hours,
        );
        expect(ranked.map((r) => r.id)).toEqual(['nara', 'east', 'open', 'illegal']);
        // SE wind into an east-open bay: the 130-140° sectors are open → not a lee.
        expect(ranked[1].score).toBeLessThan(ranked[0].score);
    });
});
