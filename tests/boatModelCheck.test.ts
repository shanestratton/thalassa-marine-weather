/**
 * "Her wind vs the models": the boat's own measured true wind set against each
 * global model's forecast for the same minutes at her position, ranked by the
 * speed gap, with honest refusals and caveats.
 *
 * Shane 2026-10-07, on the recommendation "her live wind against each model's
 * forecast for this hour at her position, ranked, with a clear caveat that one
 * reading is a snapshot, not a verdict": "go with your recommendation big
 * Claude".
 *
 * Pure: every case is built from a canned HerWindInput, session or reply. The
 * only module faked is the proxy client (fetchOpenMeteoPoints), for the
 * series cache. Every position, id and reading is fictional; the places are
 * worldwide on purpose (the Solent, the mid-Atlantic, the Hauraki Gulf).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
    calls: [] as { points: { lat: number; lon: number }[]; params: Record<string, string | number> }[],
    reply: null as null | ((points: { lat: number; lon: number }[]) => Promise<unknown[]>),
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: vi.fn(
        async (_op: string, points: { lat: number; lon: number }[], params: Record<string, string | number>) => {
            proxy.calls.push({ points, params });
            if (!proxy.reply) throw new Error('Weather service request failed (503)');
            return proxy.reply(points);
        },
    ),
}));

import {
    EMPTY_SESSION,
    HER_CLOUD_MAX_AGE_MS,
    MODEL_CHECK_DETAILS,
    MODEL_CHECK_MODELS,
    __clearModelCheckCacheForTests,
    addHerReading,
    assessHerWind,
    buildModelCheckParams,
    buildModelCheckView,
    creditLine,
    formatHerWind,
    formatWindGap,
    loadModelsAtHer,
    peekModelsAtHer,
    rankModelsAtHer,
    summarizeHerSession,
    type HerAssessment,
    type HerReading,
    type HerSession,
    type HerWindInput,
    type ModelCheckView,
    type ModelSeriesState,
} from '../components/map/boatModelCheck';
import { CLOUD_WIND_MAX_AGE_MS, formatCloseInWind } from '../components/map/closeInWind';
import { getNmeaFreshness, type TimestampedMetric } from '../services/NmeaStore';
import { parseRouteSpread, type RouteSpread } from '../services/routeForecastSpread';
import { SELECTABLE_MODELS } from '../services/weather/forecastModels';

const HOUR = 3_600_000;
/** 12:00Z on a fictional October day. */
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW = T0 + 15 * 60_000 + 30_000;
/** Off Cowes, in the Solent. */
const SOLENT = { lat: 50.77, lon: -1.3 };
/** Mid-Atlantic, nowhere near land. */
const MID_ATLANTIC = { lat: 14.2, lon: -40.6 };
/** The Hauraki Gulf. */
const HAURAKI = { lat: -36.6, lon: 175.0 };

const [ICON, ECMWF, AIFS, UKMO, JMA] = SELECTABLE_MODELS.map((m) => m.id);
const BANNED = /\bbest\b|\baccurate\b|\bis right\b|use this model/i;

const empty = (): TimestampedMetric => ({ value: null, lastUpdated: 0, freshness: 'dead' });
function metric(value: number | null, ageMs: number, now = NOW): TimestampedMetric {
    const lastUpdated = now - ageMs;
    return { value, lastUpdated, freshness: getNmeaFreshness(lastUpdated, now) };
}

type StoreInput = HerWindInput['store'];
function input(over: Partial<Omit<HerWindInput, 'store'>> & { store?: Partial<StoreInput> } = {}): HerWindInput {
    const store: StoreInput = {
        connectionStatus: 'connected',
        remote: null,
        tws: metric(12, 3_000),
        twd: empty(),
        aws: empty(),
        twaSigned: empty(),
        headingTrue: empty(),
        sog: empty(),
        stw: empty(),
        cog: empty(),
        latitude: metric(SOLENT.lat, 2_000),
        longitude: metric(SOLENT.lon, 2_000),
        ...over.store,
    };
    const { store: _ignored, ...rest } = over;
    return {
        follow: 'boat',
        crewOwnerId: null,
        followKey: 'boat',
        owned: true,
        remoteWindSample: null,
        remoteFeedEndedAt: 0,
        chainFix: null,
        cloudRow: null,
        ...rest,
        store,
    };
}

function ok(assessment: HerAssessment): HerReading {
    if (!assessment.ok) throw new Error(`refused: ${JSON.stringify(assessment.refusal)}`);
    return assessment.reading;
}
function refusal(assessment: HerAssessment) {
    if (assessment.ok) throw new Error(`read: ${JSON.stringify(assessment.reading)}`);
    return assessment.refusal;
}

function reading(over: Partial<HerReading> = {}): HerReading {
    return {
        kt: 12,
        at: NOW,
        lane: 'gateway',
        fromDeg: null,
        lat: SOLENT.lat,
        lon: SOLENT.lon,
        sogKts: 5,
        currentKts: null,
        ...over,
    };
}
function session(readings: HerReading[], lane: HerReading['lane'] = readings[0]?.lane ?? 'gateway'): HerSession {
    return { followKey: 'boat', lane, readings };
}
/** Three readings over `spanMs`, so the session is averaged when span ≥ 60 s. */
function averaged(kt: number, over: Partial<HerReading> = {}, spanMs = 120_000): HerSession {
    return session([0, spanMs / 2, spanMs].map((t) => reading({ kt, at: NOW - spanMs + t, ...over })));
}

type ModelValues = { kt: number | null | (number | null)[]; dir?: number | null | (number | null)[] };
/** One Open-Meteo multi-model reply at one point, hourly from 10:00Z to 14:00Z. */
function reply(models: Record<string, ModelValues>, hours = [-2, -1, 0, 1, 2]): { hourly: Record<string, unknown> } {
    const hourly: Record<string, unknown> = { time: hours.map((h) => (T0 + h * HOUR) / 1000) };
    for (const [id, m] of Object.entries(models)) {
        hourly[`wind_speed_10m_${id}`] = Array.isArray(m.kt) ? m.kt : hours.map(() => m.kt);
        const dir = m.dir === undefined ? 225 : m.dir;
        hourly[`wind_direction_10m_${id}`] = Array.isArray(dir) ? dir : hours.map(() => dir);
    }
    return { hourly };
}
function spreadOf(models: Record<string, ModelValues>, hours?: number[], at = SOLENT): RouteSpread {
    return parseRouteSpread([{ alongNm: 0, ...at }], [reply(models, hours)], MODEL_CHECK_MODELS, 0, T0);
}
const gaps = (rows: { id: string; gapKt: number | null; status: string }[]) =>
    rows.map((r) => [r.id, r.status === 'no-wind' ? 'no wind here' : Math.round((r.gapKt ?? NaN) * 10) / 10]);

function rank(s: HerSession, spread: RouteSpread) {
    const ranking = rankModelsAtHer(s, spread);
    if (ranking.state !== 'ranked') throw new Error('not ranked');
    return ranking;
}
const circularClose = (a: number | null, b: number) => a !== null && Math.abs(((a - b + 540) % 360) - 180) < 1e-6;

// ── assessHerWind ───────────────────────────────────────────────

describe('assessHerWind: her own true wind, or a plain refusal', () => {
    it('following the phone, or a crewed boat with no skipper known: phone', () => {
        expect(refusal(assessHerWind(input({ follow: 'phone' }), NOW))).toEqual({ kind: 'phone' });
        expect(refusal(assessHerWind(input({ follow: 'crew', crewOwnerId: null }), NOW))).toEqual({
            kind: 'phone',
        });
    });

    it('gateway: TWS 3 s old reads, dated by the store metric', () => {
        const r = ok(assessHerWind(input(), NOW));
        expect(r).toMatchObject({ kt: 12, at: NOW - 3_000, lane: 'gateway', lat: SOLENT.lat, lon: SOLENT.lon });
    });

    it('gateway: TWS 10 s old (the stale tier) still reads', () => {
        expect(ok(assessHerWind(input({ store: { tws: metric(12, 10_000) } }), NOW)).at).toBe(NOW - 10_000);
    });

    it('gateway: a dead TWS is stale with its age, in seconds then minutes', () => {
        expect(refusal(assessHerWind(input({ store: { tws: metric(null, 14_000) } }), NOW))).toEqual({
            kind: 'stale',
            ageMs: 14_000,
        });
        expect(refusal(assessHerWind(input({ store: { tws: metric(12, 120_000) } }), NOW))).toEqual({
            kind: 'stale',
            ageMs: 120_000,
        });
    });

    it('gateway direction: true heading plus the signed TWA, both on their own clocks', () => {
        const r = ok(
            assessHerWind(input({ store: { headingTrue: metric(90, 2_000), twaSigned: metric(-30, 4_000) } }), NOW),
        );
        expect(r.fromDeg).toBe(60);
        // A heading past its own 13 s: no direction, the speed still reads.
        const old = ok(
            assessHerWind(input({ store: { headingTrue: metric(90, 14_000), twaSigned: metric(-30, 4_000) } }), NOW),
        );
        expect(old.fromDeg).toBeNull();
    });

    it("gateway direction: the store's TWD is never trusted (it may be magnetic)", () => {
        expect(ok(assessHerWind(input({ store: { twd: metric(200, 1_000) } }), NOW)).fromDeg).toBeNull();
    });

    it('a live TWS of 1 kt or more with no direction still reads on speed', () => {
        // pickBoatTrueWind returns null here; it must not gate the speed.
        const r = ok(assessHerWind(input({ store: { tws: metric(18, 2_000) } }), NOW));
        expect(r).toMatchObject({ kt: 18, fromDeg: null });
    });

    it("gateway that has just replaced a remote feed: the feed's leftovers are not the gateway's", () => {
        // The store keeps a remote feed's values for their 13 s after the socket
        // comes up, stamped with this phone's receipt time, and the Pi may never
        // have dated them. The LAN lane refuses such a wind; the gateway lane must
        // not take it in instead.
        const handover = input({
            remoteFeedEndedAt: NOW - 2_000,
            store: {
                tws: metric(31, 2_000),
                aws: metric(33, 2_000),
                twaSigned: metric(-40, 2_000),
                headingTrue: metric(90, 1_000),
            },
        });
        expect(refusal(assessHerWind(handover, NOW))).toEqual({ kind: 'no-reading' });
        // The socket's own TWS comes in: that one is hers. The leftover TWA is not, so no direction.
        const own = ok(assessHerWind({ ...handover, store: { ...handover.store, tws: metric(14, 500) } }, NOW));
        expect(own).toMatchObject({ kt: 14, at: NOW - 500, lane: 'gateway', fromDeg: null });
        // And once the socket's TWS dies, it is stale by its own age, not the feed's.
        const died = { ...handover, store: { ...handover.store, tws: metric(null, 14_500), aws: empty() } };
        expect(refusal(assessHerWind({ ...died, remoteFeedEndedAt: NOW - 16_000 }, NOW))).toEqual({
            kind: 'stale',
            ageMs: 14_500,
        });
    });

    describe('the Pi over the boat LAN', () => {
        const lan = (over: Partial<Omit<HerWindInput, 'store'>> & { store?: Partial<StoreInput> } = {}) =>
            input({
                ...over,
                store: {
                    connectionStatus: 'remote',
                    remote: { via: 'lan' },
                    tws: metric(11, 2_000),
                    headingTrue: metric(90, 2_000),
                    twaSigned: metric(-30, 2_000),
                    ...over.store,
                },
            });

        // Regression gate for the latent bug: the Pi can send tws_kts with no
        // wind_tws_at_ms (pi-cache trackSignalk), PiTelemetryService.ts:200 gates
        // only on reportedAt, and NmeaStore.ts:341,356 re-stamps the value with
        // the phone's receipt time, so a frozen Signal K wind reads live.
        it('a live store TWS with no Pi sample time: undated', () => {
            expect(refusal(assessHerWind(lan(), NOW))).toEqual({ kind: 'undated' });
        });

        it('a Pi sample that is not the value in the store: undated', () => {
            expect(
                refusal(assessHerWind(lan({ remoteWindSample: { kts: 9, at: NOW - 2_000, via: 'lan' } }), NOW)),
            ).toEqual({ kind: 'undated' });
        });

        it('a Pi sample 25 s old: stale', () => {
            expect(
                refusal(assessHerWind(lan({ remoteWindSample: { kts: 11, at: NOW - 25_000, via: 'lan' } }), NOW)),
            ).toEqual({ kind: 'stale', ageMs: 25_000 });
        });

        it("a Pi sample timed 5 s ahead of this phone's clock: ahead, not undated", () => {
            expect(
                refusal(assessHerWind(lan({ remoteWindSample: { kts: 11, at: NOW + 5_000, via: 'lan' } }), NOW)),
            ).toEqual({ kind: 'ahead', aheadMs: 5_000 });
        });

        it("a Pi sample 5 s old reads at the Pi's own time, with no direction", () => {
            const r = ok(assessHerWind(lan({ remoteWindSample: { kts: 11, at: NOW - 5_000, via: 'lan' } }), NOW));
            expect(r).toMatchObject({ kt: 11, at: NOW - 5_000, lane: 'lan', fromDeg: null });
        });
    });

    describe("her cloud row through the boat chain (never the store's cloud lane)", () => {
        const cloudStore = {
            connectionStatus: 'remote',
            remote: { via: 'cloud' as const },
            // The store's cloud wind is re-stamped on receipt and may be another boat's.
            tws: metric(30, 1_000),
            latitude: metric(0.5, 1_000),
            longitude: metric(0.5, 1_000),
        };
        const row = (over: Record<string, number | undefined> = {}) => ({
            lat: HAURAKI.lat,
            lon: HAURAKI.lon,
            twsKts: 15,
            windSampleAt: NOW - 30_000,
            sogKts: 0.2,
            ...over,
        });

        it("a row sampled 30 s ago reads at the row's own position", () => {
            const r = ok(assessHerWind(input({ store: cloudStore, cloudRow: row() }), NOW));
            expect(r).toMatchObject({
                kt: 15,
                at: NOW - 30_000,
                lane: 'cloud',
                fromDeg: null,
                lat: HAURAKI.lat,
                lon: HAURAKI.lon,
                sogKts: 0.2,
                currentKts: null,
            });
        });

        it('wind with no Pi sample time: undated', () => {
            expect(
                refusal(assessHerWind(input({ store: cloudStore, cloudRow: row({ windSampleAt: undefined }) }), NOW)),
            ).toEqual({ kind: 'undated' });
        });

        it('a sample 70 s old: stale', () => {
            expect(
                refusal(
                    assessHerWind(input({ store: cloudStore, cloudRow: row({ windSampleAt: NOW - 70_000 }) }), NOW),
                ),
            ).toEqual({ kind: 'stale', ageMs: 70_000 });
        });

        it("a sample timed ahead of this phone's clock: ahead past a second, a reading inside it", () => {
            expect(
                refusal(assessHerWind(input({ store: cloudStore, cloudRow: row({ windSampleAt: NOW + 5_000 }) }), NOW)),
            ).toEqual({ kind: 'ahead', aheadMs: 5_000 });
            expect(
                ok(assessHerWind(input({ store: cloudStore, cloudRow: row({ windSampleAt: NOW + 800 }) }), NOW)).at,
            ).toBe(NOW + 800);
        });

        it('no row, or a row with no wind: no-reading', () => {
            expect(refusal(assessHerWind(input({ store: cloudStore, cloudRow: null }), NOW))).toEqual({
                kind: 'no-reading',
            });
            expect(
                refusal(assessHerWind(input({ store: cloudStore, cloudRow: row({ twsKts: undefined }) }), NOW)),
            ).toEqual({ kind: 'no-reading' });
        });

        it('instruments that are not hers fall through to her row', () => {
            const r = ok(assessHerWind(input({ owned: false, cloudRow: row() }), NOW));
            expect(r.lane).toBe('cloud');
        });
    });

    it('apparent wind only, on the gateway and on the LAN: apparent-only', () => {
        const apparent = { tws: empty(), aws: metric(16, 2_000) };
        expect(refusal(assessHerWind(input({ store: apparent }), NOW))).toEqual({ kind: 'apparent-only' });
        expect(
            refusal(
                assessHerWind(
                    input({ store: { ...apparent, connectionStatus: 'remote', remote: { via: 'lan' } } }),
                    NOW,
                ),
            ),
        ).toEqual({ kind: 'apparent-only' });
    });

    it('her wind with no store GPS and no chain fix: no-position (there is no phone input to fall back on)', () => {
        const noGps = input({ store: { latitude: empty(), longitude: empty() }, chainFix: null });
        expect(Object.keys(noGps)).not.toContain('phone');
        expect(refusal(assessHerWind(noGps, NOW))).toEqual({ kind: 'no-position' });
    });

    it('a store GPS 20 s old gives way to the chain fix', () => {
        const r = ok(
            assessHerWind(
                input({
                    store: { latitude: metric(SOLENT.lat, 20_000), longitude: metric(SOLENT.lon, 20_000) },
                    chainFix: MID_ATLANTIC,
                }),
                NOW,
            ),
        );
        expect(r).toMatchObject(MID_ATLANTIC);
    });

    it('current under her: |SOG − STW| while both are usable, unknown with a fouled log', () => {
        const at = (sog: TimestampedMetric, stw: TimestampedMetric) =>
            ok(assessHerWind(input({ store: { sog, stw } }), NOW)).currentKts;
        expect(at(metric(6, 2_000), metric(4, 2_000))).toBeCloseTo(2, 9);
        expect(at(metric(6, 2_000), metric(null, 20_000))).toBeNull();
        expect(at(metric(5, 2_000), metric(0.1, 2_000))).toBeNull();
    });
});

// ── addHerReading / summarizeHerSession ─────────────────────────

describe('the session buffer', () => {
    it('drops a duplicate or an older sample time', () => {
        const one = addHerReading(EMPTY_SESSION, reading({ at: NOW - 5_000 }), 'boat', NOW);
        expect(one.readings).toHaveLength(1);
        expect(addHerReading(one, reading({ at: NOW - 5_000, kt: 99 }), 'boat', NOW)).toBe(one);
        expect(addHerReading(one, reading({ at: NOW - 9_000 }), 'boat', NOW).readings).toHaveLength(1);
        expect(addHerReading(one, reading({ at: NOW }), 'boat', NOW).readings).toHaveLength(2);
    });

    it('a lane change or a follow-key change starts again; pruning keeps 10 minutes', () => {
        let s = EMPTY_SESSION;
        for (let t = 0; t <= 4; t++) s = addHerReading(s, reading({ at: NOW - 60_000 + t * 5_000 }), 'boat', NOW);
        expect(s.readings).toHaveLength(5);
        expect(addHerReading(s, reading({ at: NOW, lane: 'lan' }), 'boat', NOW).readings).toHaveLength(1);
        expect(addHerReading(s, reading({ at: NOW }), 'crew:skipper-tern', NOW).readings).toHaveLength(1);
        const later = NOW + 10 * 60_000 - 50_000;
        const pruned = addHerReading(s, reading({ at: later }), 'boat', later);
        expect(pruned.readings.map((r) => r.at)).toEqual([NOW - 50_000, NOW - 45_000, NOW - 40_000, later]);
    });

    it('snapshot while n < 3 or the span is under 60 s, averaged after', () => {
        expect(summarizeHerSession(session([reading()]))?.mode).toBe('snapshot');
        expect(summarizeHerSession(session([reading({ at: NOW - 120_000 }), reading({ at: NOW })]))?.mode).toBe(
            'snapshot',
        );
        expect(summarizeHerSession(averaged(12, {}, 59_000))?.mode).toBe('snapshot');
        expect(summarizeHerSession(averaged(12, {}, 60_000))).toMatchObject({ mode: 'averaged', n: 3 });
        expect(summarizeHerSession(EMPTY_SESSION)).toBeNull();
    });
});

// ── rankModelsAtHer ─────────────────────────────────────────────

describe('rankModelsAtHer: closest first by the speed gap', () => {
    it('snapshot, W 12: ICON +1, AIFS +2, ECMWF −3, UKMO +8, JMA no wind; a 1.8 kt margin ties ICON and AIFS', () => {
        const spread = spreadOf({ [ICON]: { kt: 13 }, [ECMWF]: { kt: 9 }, [AIFS]: { kt: 14 }, [UKMO]: { kt: 20 } });
        const ranking = rank(session([reading({ kt: 12 })]), spread);
        expect(gaps(ranking.rows)).toEqual([
            [ICON, 1],
            [AIFS, 2],
            [ECMWF, -3],
            [UKMO, 8],
            [JMA, 'no wind here'],
        ]);
        expect(ranking.marginKt).toBeCloseTo(1.8, 9);
        expect(ranking.verdict).toEqual({ kind: 'too-close', ids: [ICON, AIFS] });
        expect(ranking.rows.filter((r) => r.marked).map((r) => r.id)).toEqual([ICON, AIFS]);
    });

    it('the margin depends on the mode: averaged 10 % calls a winner where a snapshot ties', () => {
        const spread = spreadOf({ [ICON]: { kt: 21 }, [ECMWF]: { kt: 23.5 } });
        const avg = rank(averaged(20), spread);
        expect(avg.marginKt).toBeCloseTo(2, 9);
        expect(avg.verdict).toEqual({ kind: 'closest', id: ICON, judged: false });
        const snap = rank(session([reading({ kt: 20 })]), spread);
        expect(snap.marginKt).toBeCloseTo(3, 9);
        expect(snap.verdict).toEqual({ kind: 'too-close', ids: [ICON, ECMWF] });
    });

    it('2 kt of current widens the margin and turns a single winner into a tie', () => {
        const spread = spreadOf({ [ICON]: { kt: 21 }, [ECMWF]: { kt: 23.5 } });
        const r = rank(averaged(20, { currentKts: 2 }), spread);
        expect(r.marginKt).toBeCloseTo(4, 9);
        expect(r.verdict).toEqual({ kind: 'too-close', ids: [ICON, ECMWF] });
    });

    it('current is capped at 3 kt and counted only when half the samples carry it', () => {
        const spread = spreadOf({ [ICON]: { kt: 21 }, [ECMWF]: { kt: 23.5 } });
        expect(rank(averaged(20, { currentKts: 6 }), spread).marginKt).toBeCloseTo(5, 9);
        const sparse = session([
            reading({ kt: 20, at: NOW - 120_000, currentKts: 2 }),
            reading({ kt: 20, at: NOW - 90_000, currentKts: 2 }),
            reading({ kt: 20, at: NOW - 60_000 }),
            reading({ kt: 20, at: NOW }),
        ]);
        expect(summarizeHerSession(sparse)?.currentKts).toBe(2);
        const fewer = session([...sparse.readings, reading({ kt: 20, at: NOW + 1 })]);
        expect(summarizeHerSession(fewer)?.currentKts).toBeNull();
    });

    it('the closest of exactly 8 kt off: none is close, and nothing is marked', () => {
        const r = rank(session([reading({ kt: 12 })]), spreadOf({ [ICON]: { kt: 20 }, [ECMWF]: { kt: 21 } }));
        expect(r.verdict).toEqual({ kind: 'none-close' });
        expect(r.rows.some((row) => row.marked)).toBe(false);
    });

    it('one model with wind: only that one; none at all: no-models', () => {
        const only = rank(session([reading()]), spreadOf({ [UKMO]: { kt: 30 } }));
        expect(only.verdict).toEqual({ kind: 'only', id: UKMO });
        expect(only.rows.some((row) => row.marked)).toBe(false);
        const none: RouteSpread = {
            asked: [...MODEL_CHECK_MODELS],
            members: {},
            missing: [...MODEL_CHECK_MODELS],
            fetchedAt: T0,
        };
        expect(rankModelsAtHer(session([reading()]), none)).toEqual({ state: 'no-models' });
    });

    it('two answered but only one has wind at her minutes: only that one, nothing marked, both credited', () => {
        // JMA has 10:00Z and 11:00Z only; her reading is at 13:05Z.
        const spread = spreadOf({ [ICON]: { kt: 19 }, [JMA]: { kt: [10, 10, null, null, null] } });
        const her = session([reading({ kt: 12, at: T0 + 65 * 60_000 })]);
        const r = rank(her, spread);
        expect(gaps(r.rows)).toEqual([
            [ICON, 7],
            [ECMWF, 'no wind here'],
            [AIFS, 'no wind here'],
            [UKMO, 'no wind here'],
            [JMA, 'no wind here'],
        ]);
        expect(r.verdict).toEqual({ kind: 'only', id: ICON });
        expect(r.rows.some((row) => row.marked)).toBe(false);
        expect(r.answered).toEqual([ICON, JMA]);
        const v = view({ session: her, series: READY(spread) });
        expect(v.verdict).toBe('Only ICON has wind here now');
        expect(v.rows.every((row) => row.mark === null)).toBe(true);
        expect(v.credit).toBe('Data via Open-Meteo: DWD, JMA (CC BY 4.0)');
    });

    describe('direction (never part of the rank)', () => {
        it('her 10 kt from 090 against a model 10 kt from 150: 60° off, and out of the running', () => {
            const r = rank(
                session([reading({ kt: 10, fromDeg: 90 })]),
                spreadOf({ [ICON]: { kt: 10, dir: 150 }, [ECMWF]: { kt: 13, dir: 95 } }),
            );
            const icon = r.rows.find((row) => row.id === ICON)!;
            expect(icon).toMatchObject({ status: 'direction-off', judged: true });
            expect(icon.offDeg).toBeCloseTo(60, 6);
            expect(r.verdict).toEqual({ kind: 'closest', id: ECMWF, judged: true });
            expect(r.rows.map((row) => row.id).slice(0, 2)).toEqual([ECMWF, ICON]);
        });

        it('her 5 kt: direction not judged', () => {
            const r = rank(
                session([reading({ kt: 5, fromDeg: 90 })]),
                spreadOf({ [ICON]: { kt: 10, dir: 150 }, [ECMWF]: { kt: 7, dir: 95 } }),
            );
            expect(r.rows.every((row) => !row.judged && row.status !== 'direction-off')).toBe(true);
            expect(r.verdict).toEqual({ kind: 'closest', id: ECMWF, judged: false });
        });

        it('350° against 010° is 20° apart, the short way round: not off', () => {
            const r = rank(
                session([reading({ kt: 10, fromDeg: 350 })]),
                spreadOf({ [ICON]: { kt: 10, dir: 10 }, [ECMWF]: { kt: 16, dir: 350 } }),
            );
            const icon = r.rows.find((row) => row.id === ICON)!;
            expect(icon).toMatchObject({ status: 'ranked', judged: true });
            expect(icon.offDeg).toBeCloseTo(20, 6);
            expect(r.verdict).toEqual({ kind: 'closest', id: ICON, judged: true });
        });

        it('every model off her direction: none has her wind direction', () => {
            const r = rank(
                session([reading({ kt: 10, fromDeg: 90 })]),
                spreadOf({ [ICON]: { kt: 10, dir: 200 }, [ECMWF]: { kt: 10, dir: 250 } }),
            );
            expect(r.verdict).toEqual({ kind: 'none-direction' });
            expect(r.rows.some((row) => row.marked)).toBe(false);
        });

        it('the LAN lane is never judged, even if a reading carried a bearing', () => {
            const r = rank(
                session([reading({ kt: 10, fromDeg: 90, lane: 'lan' })]),
                spreadOf({ [ICON]: { kt: 10, dir: 200 }, [ECMWF]: { kt: 14, dir: 90 } }),
            );
            expect(r.rows.every((row) => !row.judged)).toBe(true);
            expect(r.verdict).toEqual({ kind: 'closest', id: ICON, judged: false });
        });
    });

    it('equal gaps keep the picker order (SELECTABLE_MODELS), not the reply order', () => {
        const r = rank(
            session([reading({ kt: 12 })]),
            spreadOf({ [UKMO]: { kt: 14 }, [AIFS]: { kt: 10 }, [ECMWF]: { kt: 30 } }),
        );
        expect(r.rows.map((row) => row.id)).toEqual([AIFS, UKMO, ECMWF, ICON, JMA]);
    });

    it('a model with wind at only some of her sample times: no wind here', () => {
        const at = (minute: number) => T0 + minute * 60_000 + 30_000;
        const s = session([25, 30, 35].map((m) => reading({ kt: 12, at: at(m) })));
        const spread = spreadOf({ [ICON]: { kt: 12 }, [JMA]: { kt: [10, 10, 10, null, null] } });
        const r = rank(s, spread);
        expect(r.rows.find((row) => row.id === JMA)?.status).toBe('no-wind');
        expect(r.answered).toEqual([ICON, JMA]);
    });

    it('interpolates speed linearly and direction round north between the hours', () => {
        const spread = spreadOf({
            [ICON]: { kt: [10, 10, 10, 14, 14], dir: [350, 350, 350, 10, 10] },
            [ECMWF]: { kt: 30 },
        });
        const r = rank(session([reading({ kt: 12, at: T0 + 30 * 60_000 })]), spread);
        const icon = r.rows.find((row) => row.id === ICON)!;
        expect(icon.meanKt).toBeCloseTo(12, 9);
        expect(circularClose(icon.fromDeg, 0)).toBe(true);
    });
});

// ── formatWindGap ───────────────────────────────────────────────

describe('formatWindGap: in her units, never a hard-coded knot', () => {
    it('kts, mph, km/h and m/s, over and under', () => {
        expect(formatWindGap(2.2, 'kts')).toEqual({ short: '2 over', long: '2 kt over her wind' });
        expect(formatWindGap(-6, 'mph')).toEqual({ short: '7 under', long: '7 mph under her wind' });
        expect(formatWindGap(2, 'kmh')).toEqual({ short: '4 over', long: '4 km/h over her wind' });
        expect(formatWindGap(2, 'mps')).toEqual({ short: '1.0 over', long: '1.0 m/s over her wind' });
        expect(formatWindGap(-25, 'mps')).toEqual({ short: '13 under', long: '13 m/s under her wind' });
    });

    it('a gap that rounds to nothing in the display unit is the same', () => {
        expect(formatWindGap(0.3, 'kts')).toEqual({ short: 'same', long: 'the same as her wind' });
        expect(formatWindGap(-0.04, 'mps')).toEqual({ short: 'same', long: 'the same as her wind' });
        expect(formatWindGap(0.6, 'kts').short).toBe('1 over');
    });

    it('the module spells no unit outside its one label table', () => {
        const source = readFileSync(resolve(process.cwd(), 'components/map/boatModelCheck.ts'), 'utf8');
        const table = /^const SPEED_LABEL: Record<string, string> = \{[^}\n]*\};$/m;
        expect(source).toMatch(table);
        expect(source.replace(table, '')).not.toMatch(/['"`][^'"`\n]*\b(kt|kts|knots)\b[^'"`\n]*['"`]/);
    });

    it("the gap's unit is the readout's unit", () => {
        for (const unit of ['kts', 'mph', 'kmh', 'mps']) {
            const label = formatCloseInWind({ kt: 30, fromDeg: null }, unit).split(' ').slice(1).join(' ');
            expect(formatWindGap(30, unit).long).toContain(` ${label} over`);
        }
    });
});

// ── her readout, kept out of the chart's chunk ──────────────────

describe("formatHerWind: the chart's close-in readout, without the chart's chunk", () => {
    it('is formatCloseInWind, unit for unit and wind for wind', () => {
        const winds = [
            { kt: Number.NaN, fromDeg: null },
            { kt: 0.4, fromDeg: 180 },
            { kt: 1, fromDeg: 0 },
            { kt: 5.55, fromDeg: 359.9 },
            { kt: 12, fromDeg: 225 },
            { kt: 19.4, fromDeg: -30 },
            { kt: 30, fromDeg: 725 },
            { kt: 64, fromDeg: null },
        ];
        for (const unit of [undefined, 'kts', 'mph', 'kmh', 'mps', 'furlongs'])
            for (const wind of winds)
                expect(formatHerWind(wind, unit), `${unit} ${wind.kt}`).toBe(formatCloseInWind(wind, unit));
    });

    it("the cloud lane's 60 s gate is closeInWind's", () => {
        expect(HER_CLOUD_MAX_AGE_MS).toBe(CLOUD_WIND_MAX_AGE_MS);
    });
});

// ── buildModelCheckView ─────────────────────────────────────────

const ONE_READING = 'One reading is a snapshot, not a verdict.';
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const READY = (spread: RouteSpread): ModelSeriesState => ({ state: 'ready', spread });
const FIVE = spreadOf({
    [ICON]: { kt: 13, dir: 225 },
    [ECMWF]: { kt: 9, dir: 225 },
    [AIFS]: { kt: 14, dir: 225 },
    [UKMO]: { kt: 20, dir: 225 },
});

function view(over: Partial<Parameters<typeof buildModelCheckView>[0]> = {}): ModelCheckView {
    const s = over.session ?? session([reading({ kt: 12 })]);
    return buildModelCheckView({
        assessment: { ok: true, reading: s.readings[s.readings.length - 1] ?? reading() },
        session: s,
        series: READY(FIVE),
        follow: 'boat',
        speedUnit: 'kts',
        lengthUnit: 'm',
        airDraftFt: undefined,
        chartModel: 'icon',
        ...over,
    });
}
const refused = (r: Extract<HerAssessment, { ok: false }>['refusal']) =>
    view({ assessment: { ok: false, refusal: r }, session: EMPTY_SESSION });
const allText = (v: ModelCheckView) =>
    [
        v.caveat,
        v.status?.line1,
        v.status?.line2,
        v.her?.value,
        v.her?.source,
        v.verdict,
        ...v.rows.flatMap((r) => [r.label, r.forecast, r.gap, r.gapLong]),
        ...v.notes,
        v.credit,
    ].filter((s): s is string => typeof s === 'string');

describe('buildModelCheckView: every string the card shows', () => {
    it('a series asked for more than 10 NM from her newest reading is never ranked against her', () => {
        // FIVE was asked for off Cowes; a reply for where she (or the boat followed before) was.
        const far = view({ session: session([reading({ kt: 12, lat: SOLENT.lat + 11 / 60 })]) });
        expect(far.status).toEqual({ line1: 'Getting the models at her position…', line2: null });
        expect(far.her).not.toBeNull();
        expect(far.verdict).toBeNull();
        expect(far.rows).toEqual([]);
        expect(far.credit).toBeNull();
        expect(view({ session: session([reading({ kt: 12, lat: SOLENT.lat + 9 / 60 })]) }).rows).toHaveLength(5);
    });

    it.each([
        [
            { kind: 'phone' as const },
            'Current Location is following this phone, not a boat.',
            'Set it to your boat to compare her wind with the models.',
        ],
        [
            { kind: 'no-reading' as const },
            'No wind reading from her right now, so there is nothing to compare.',
            'Aboard, her Pi or wind gateway has to reach this phone. Ashore, her Pi has to be online.',
        ],
        [
            { kind: 'stale' as const, ageMs: 14_000 },
            'Her last wind reading is 14 s old.',
            'Nothing is ranked until a fresh one comes in.',
        ],
        [
            { kind: 'stale' as const, ageMs: 120_000 },
            'Her last wind reading is 2 min old.',
            'Nothing is ranked until a fresh one comes in.',
        ],
        [
            { kind: 'undated' as const },
            'Her Pi sent a wind reading with no time on it.',
            'It may be an old value from instruments that are off, so nothing is ranked.',
        ],
        [
            { kind: 'ahead' as const, aheadMs: 5_000 },
            "Her wind reading is stamped 5 s ahead of this phone's clock.",
            'One of the two clocks is wrong, so nothing is ranked.',
        ],
        [
            { kind: 'apparent-only' as const },
            'She is sending apparent wind only.',
            'The models forecast true wind, so nothing is ranked.',
        ],
        [
            { kind: 'no-position' as const },
            'We have her wind but not her position.',
            "The models can't be looked up without it.",
        ],
    ])('refusal %o', (r, line1, line2) => {
        const v = refused(r);
        expect(v.status).toEqual({ line1, line2 });
        expect(v.caveat).toBe(ONE_READING);
        expect(v.her).toBeNull();
        expect(v.verdict).toBeNull();
        expect(v.rows).toEqual([]);
        expect(v.notes).toEqual([]);
        expect(v.credit).toBeNull();
    });

    it.each([
        [null, 'Getting the models at her position…', null],
        [{ state: 'loading' } as const, 'Getting the models at her position…', null],
        [{ state: 'offline' } as const, "This phone is offline, so the models can't be looked up.", null],
        [
            { state: 'failed', retryInMs: 61_000 } as const,
            "Couldn't reach the forecast service.",
            'Trying again in 2 min.',
        ],
        [
            { state: 'failed', retryInMs: 2_000 } as const,
            "Couldn't reach the forecast service.",
            'Trying again in 1 min.',
        ],
        [
            { state: 'rate-limited', retryInMs: 30 * 60_000 } as const,
            'Forecast requests are paused for now.',
            'Too many from this connection. Trying again in 30 min.',
        ],
        [{ state: 'no-models' } as const, 'No model has wind for her position this hour.', null],
    ])('model side %o: her block, no rows, no credit', (series, line1, line2) => {
        const v = view({ series });
        expect(v.status).toEqual({ line1, line2 });
        expect(v.her).toEqual({ value: '12 kt', source: `Boat instruments · ${hhmm(NOW)}` });
        expect(v.caveat).toBe(ONE_READING);
        expect(v.rows).toEqual([]);
        expect(v.verdict).toBeNull();
        expect(v.credit).toBeNull();
    });

    it("off-series: her reading's time is outside the forecast hours", () => {
        const late = session([reading({ at: T0 + 3 * HOUR })]);
        const v = view({ session: late });
        expect(v.status).toEqual({
            line1: "The forecast hours don't cover her reading's time.",
            line2: "Check this phone's clock.",
        });
        expect(v.rows).toEqual([]);
        expect(v.credit).toBeNull();
    });

    it('ranked, snapshot: verdict, rows closest first, the height note and the credit', () => {
        const v = view();
        expect(v.caveat).toBe(ONE_READING);
        expect(v.status).toBeNull();
        expect(v.her).toEqual({ value: '12 kt', source: `Boat instruments · ${hhmm(NOW)}` });
        expect(v.verdict).toBe('Too close to call: ICON and AIFS');
        expect(v.rows.map((r) => [r.label, r.forecast, r.gap, r.mark, r.tone])).toEqual([
            ['ICON', '13 kt SW', '1 over', 'too-close', 'emerald'],
            ['AIFS', '14 kt SW', '2 over', 'too-close', 'emerald'],
            ['ECMWF', '9 kt SW', '3 under', null, 'emerald'],
            ['UKMO', '20 kt SW', '8 over', null, 'rose'],
            ['JMA', '—', 'no wind here', null, null],
        ]);
        expect(v.rows[0].gapLong).toBe('1 kt over her wind');
        expect(v.rows[4].gapLong).toBe('no wind here from this model');
        expect(v.notes).toEqual(['Models are for 10 m up. A masthead anemometer usually reads a little more.']);
        expect(v.credit).toBe('Data via Open-Meteo: DWD, ECMWF (CC BY 4.0); UK Met Office (CC BY-SA 4.0)');
    });

    it('averaged: the caveat and her source line name the minutes', () => {
        const v = view({ session: averaged(12, {}, 180_000) });
        expect(v.caveat).toBe('3 min of her wind is a snapshot, not a verdict.');
        expect(v.her?.source).toBe(`Boat instruments · 3-min average to ${hhmm(NOW)}`);
        const oneMin = view({ session: averaged(12, {}, 60_000) });
        expect(oneMin.caveat).toBe('1 min of her wind is a snapshot, not a verdict.');
    });

    it('her source names the lane', () => {
        expect(view({ session: session([reading({ lane: 'lan' })]) }).her?.source).toBe(
            `Boat instruments via the Pi · ${hhmm(NOW)}`,
        );
        expect(view({ session: session([reading({ lane: 'cloud' })]) }).her?.source).toBe(
            `Her Pi, online · ${hhmm(NOW)}`,
        );
    });

    it('her value carries her direction when it is trusted, and Calm under 1 kt', () => {
        expect(view({ session: session([reading({ kt: 13, fromDeg: 225 })]) }).her?.value).toBe('13 kt SW');
        expect(view({ session: session([reading({ kt: 0.4 })]) }).her?.value).toBe('Calm');
    });

    it('the verdict, every wording', () => {
        const s12 = session([reading({ kt: 12 })]);
        expect(
            view({ session: s12, series: READY(spreadOf({ [ICON]: { kt: 12 }, [ECMWF]: { kt: 30 } })) }).verdict,
        ).toBe('Closest on speed: ICON');
        expect(
            view({
                session: session([reading({ kt: 12, fromDeg: 225 })]),
                series: READY(spreadOf({ [ICON]: { kt: 12 }, [ECMWF]: { kt: 30 } })),
            }).verdict,
        ).toBe('Closest right now: ICON');
        expect(
            view({
                session: s12,
                series: READY(spreadOf({ [ICON]: { kt: 12 }, [ECMWF]: { kt: 13 }, [UKMO]: { kt: 11 } })),
            }).verdict,
        ).toBe('Too close to call: ICON, ECMWF and UKMO');
        expect(
            view({ session: s12, series: READY(spreadOf({ [ICON]: { kt: 25 }, [ECMWF]: { kt: 30 } })) }).verdict,
        ).toBe('None is close to her right now');
        expect(
            view({
                session: session([reading({ kt: 12, fromDeg: 45 })]),
                series: READY(spreadOf({ [ICON]: { kt: 12 }, [ECMWF]: { kt: 13 } })),
            }).verdict,
        ).toBe('None has her wind direction now');
        expect(view({ session: s12, series: READY(spreadOf({ [JMA]: { kt: 12 } })) }).verdict).toBe(
            'Only JMA has wind here now',
        );
    });

    it('rows: the direction-off gap, the chart model flag and the marks', () => {
        const v = view({
            session: session([reading({ kt: 10, fromDeg: 90 })]),
            series: READY(spreadOf({ [ICON]: { kt: 10, dir: 150 }, [ECMWF]: { kt: 13, dir: 95 } })),
            chartModel: 'ecmwf',
        });
        expect(v.verdict).toBe('Closest right now: ECMWF');
        expect(v.rows[0]).toMatchObject({ id: ECMWF, onChart: true, mark: 'closest', gap: '3 over' });
        expect(v.rows[1]).toMatchObject({ id: ICON, onChart: false, mark: null, gap: '60° off', tone: 'amber' });
        expect(v.rows[1].gapLong).toBe("60° off her wind's direction");
        expect(v.rows.filter((r) => r.onChart).map((r) => r.id)).toEqual([ECMWF]);
    });

    it('the gap tone: under 4 emerald, 4 to 8 amber, 8 and over rose', () => {
        const v = view({
            series: READY(spreadOf({ [ICON]: { kt: 15.9 }, [ECMWF]: { kt: 16 }, [AIFS]: { kt: 20 } })),
        });
        expect(v.rows.map((r) => [r.id, r.tone])).toEqual([
            [ICON, 'emerald'],
            [ECMWF, 'amber'],
            [AIFS, 'rose'],
            [UKMO, null],
            [JMA, null],
        ]);
    });

    it('the credit names only who answered; ECMWF once for IFS and AIFS; never empty', () => {
        // UK Met Office data is CC BY-SA 4.0, so it is credited under its own
        // licence rather than folded into the CC BY list.
        expect(creditLine([ICON, ECMWF, UKMO])).toBe(
            'Data via Open-Meteo: DWD, ECMWF (CC BY 4.0); UK Met Office (CC BY-SA 4.0)',
        );
        expect(creditLine([AIFS, ECMWF, JMA])).toBe('Data via Open-Meteo: ECMWF, JMA (CC BY 4.0)');
        expect(creditLine([UKMO])).toBe('Data via Open-Meteo: UK Met Office (CC BY-SA 4.0)');
        expect(creditLine([])).toBeNull();
        for (const m of SELECTABLE_MODELS) {
            expect(m.provider.trim()).not.toBe('');
            expect(creditLine([m.id])).toMatch(
                new RegExp(`^Data via Open-Meteo: ${m.provider} \\(CC BY(-SA)? 4\\.0\\)$`),
            );
        }
    });

    it('the height note: her mast in her length unit, a low anemometer, or the generic note', () => {
        const eighteenMetresFt = 18 * 3.28084;
        expect(view({ lengthUnit: 'ft', airDraftFt: eighteenMetresFt }).notes[0]).toBe(
            'Models are for 10 m up. Her mast is up to 59 ft, so she may read a little more.',
        );
        expect(view({ lengthUnit: 'm', airDraftFt: eighteenMetresFt }).notes[0]).toBe(
            'Models are for 10 m up. Her mast is up to 18 m, so she may read a little more.',
        );
        expect(view({ lengthUnit: 'm', airDraftFt: 30 }).notes[0]).toBe(
            'Models are for 10 m up. Her anemometer is lower, so she may read a little less.',
        );
        const generic = 'Models are for 10 m up. A masthead anemometer usually reads a little more.';
        expect(view({ follow: 'crew', airDraftFt: eighteenMetresFt }).notes[0]).toBe(generic);
        expect(view({ airDraftFt: undefined }).notes[0]).toBe(generic);
    });

    it('at most one situational note, current before shelter', () => {
        const current = 'About 2 kt of tide or current under her shifts her wind against the models.';
        const shelter =
            "She isn't moving. In a marina or sheltered anchorage, land, buildings and masts can cut her wind.";
        expect(view({ session: averaged(12, { currentKts: 2, sogKts: 0.2 }) }).notes.slice(1)).toEqual([current]);
        expect(view({ session: averaged(12, { sogKts: 0.2 }) }).notes.slice(1)).toEqual([shelter]);
        expect(view({ session: averaged(12, { currentKts: 0.6, sogKts: 6 }) }).notes).toHaveLength(1);
        expect(view({ session: averaged(12, { currentKts: 2 }), speedUnit: 'kmh' }).notes[1]).toBe(
            'About 4 km/h of tide or current under her shifts her wind against the models.',
        );
    });

    it('the rows and credit follow her speed unit', () => {
        const v = view({ speedUnit: 'kmh' });
        expect(v.her?.value).toBe('22 km/h');
        expect(v.rows[0]).toMatchObject({ forecast: '24 km/h SW', gap: '2 over', gapLong: '2 km/h over her wind' });
    });

    it('never says best, accurate, is right or use this model, in any state', () => {
        const views: ModelCheckView[] = [
            view(),
            view({ session: averaged(12, { currentKts: 2, sogKts: 0.1 }), speedUnit: 'mph' }),
            view({
                session: session([reading({ kt: 10, fromDeg: 90 })]),
                series: READY(spreadOf({ [ICON]: { kt: 10, dir: 200 } })),
            }),
            ...(['phone', 'no-reading', 'undated', 'apparent-only', 'no-position'] as const).map((kind) =>
                refused({ kind }),
            ),
            refused({ kind: 'stale', ageMs: 30_000 }),
            refused({ kind: 'ahead', aheadMs: 120_000 }),
            ...([null, { state: 'offline' }, { state: 'no-models' }] as const).map((series) => view({ series })),
            view({ series: { state: 'failed', retryInMs: 60_000 } }),
            view({ series: { state: 'rate-limited', retryInMs: 60_000 } }),
        ];
        for (const v of views) for (const text of allText(v)) expect(text).not.toMatch(BANNED);
        for (const text of MODEL_CHECK_DETAILS) expect(text).not.toMatch(BANNED);
        expect(MODEL_CHECK_DETAILS).toHaveLength(5);
    });
});

// ── the request, against the proxy's own source ────────────────

describe('buildModelCheckParams: every value the proxy accepts (a 400 still spends a quota unit)', () => {
    // The vocabulary moved to validation.ts in build 125 (SND); read the function whole.
    const proxySource = ['index.ts', 'validation.ts']
        .map((file) => readFileSync(resolve(process.cwd(), 'supabase/functions/proxy-openmeteo', file), 'utf8'))
        .join('\n');
    const setOf = (name: string): Set<string> => {
        const match = proxySource.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
        if (!match) throw new Error(`${name} not found in the proxy`);
        const out = new Set<string>();
        for (const item of match[1].matchAll(/'([^']+)'|\.\.\.([A-Z_]+)/g)) {
            if (item[1]) out.add(item[1]);
            else for (const inner of setOf(item[2])) out.add(inner);
        }
        return out;
    };
    const params = buildModelCheckParams(SOLENT.lat, SOLENT.lon, NOW);

    it('every key, latitude and longitude included, is a COMMON_PARAMETER; 3 to 18 keys', () => {
        const keys = [...Object.keys(params), 'latitude', 'longitude'];
        const common = setOf('COMMON_PARAMETERS');
        for (const key of keys) expect(common.has(key), key).toBe(true);
        expect(keys.length).toBeGreaterThanOrEqual(3);
        expect(keys.length).toBeLessThanOrEqual(18);
        expect(params).not.toHaveProperty('past_hours');
        expect(params).not.toHaveProperty('forecast_hours');
        expect(params).not.toHaveProperty('latitude');
    });

    it('two wind variables only, both forecast hourly variables; no gusts', () => {
        expect(params.hourly).toBe('wind_speed_10m,wind_direction_10m');
        const hourly = setOf('FORECAST_HOURLY');
        for (const v of String(params.hourly).split(',')) expect(hourly.has(v)).toBe(true);
    });

    it('the five global models: unique, the picker ids, all allowed, at most 8', () => {
        const ids = String(params.models).split(',');
        expect(ids).toEqual(SELECTABLE_MODELS.map((m) => m.id));
        expect(MODEL_CHECK_MODELS).toEqual(ids);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(8);
        const allowed = setOf('FORECAST_MODELS');
        for (const id of ids) expect(allowed.has(id), id).toBe(true);
    });

    it('enum values the proxy allows, and the wind over the sea', () => {
        expect(params).toMatchObject({
            wind_speed_unit: 'kn',
            timeformat: 'unixtime',
            timezone: 'UTC',
            cell_selection: 'sea',
        });
        for (const [name, value] of [
            ['wind_speed_unit', 'kn'],
            ['timeformat', 'unixtime'],
            ['cell_selection', 'sea'],
        ]) {
            expect(proxySource).toMatch(new RegExp(`${name}: new Set\\(\\[[^\\]]*'${value}'`));
        }
        expect(proxySource).toContain("timezone === 'UTC'");
    });

    it('dates: an hour and five minutes either side, in UTC days', () => {
        const at = (h: number, m: number) => buildModelCheckParams(0, 0, Date.UTC(2026, 9, 7, h, m));
        expect(at(23, 30)).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-08' });
        expect(at(0, 30)).toMatchObject({ start_date: '2026-10-06', end_date: '2026-10-07' });
        expect(at(12, 0)).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-07' });
    });
});

// ── the series cache ────────────────────────────────────────────

describe('loadModelsAtHer: one request per 10 NM and hour, none on a refusal', () => {
    const goodReply = async (points: { lat: number; lon: number }[]) =>
        points.map(() => reply({ [ICON]: { kt: 12 }, [ECMWF]: { kt: 14 }, [UKMO]: { kt: null, dir: 200 } }));

    beforeEach(() => {
        __clearModelCheckCacheForTests();
        proxy.calls = [];
        proxy.reply = goodReply;
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('asks once at her point with the contract params, then reuses within 10 NM and 60 min', async () => {
        const first = await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW);
        expect(first.state).toBe('ready');
        expect(proxy.calls).toHaveLength(1);
        expect(proxy.calls[0].points).toEqual([SOLENT]);
        expect(proxy.calls[0].params).toEqual(buildModelCheckParams(SOLENT.lat, SOLENT.lon, NOW));
        // Five miles on, twenty minutes later: the same series.
        const near = { lat: SOLENT.lat + 5 / 60, lon: SOLENT.lon };
        expect(peekModelsAtHer(near.lat, near.lon, NOW + 20 * 60_000)?.state).toBe('ready');
        expect((await loadModelsAtHer(near.lat, near.lon, NOW + 20 * 60_000)).state).toBe('ready');
        expect(proxy.calls).toHaveLength(1);
    });

    it('11 NM away, or 61 minutes on: a new request', async () => {
        await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW);
        const far = { lat: SOLENT.lat + 11 / 60, lon: SOLENT.lon };
        expect(peekModelsAtHer(far.lat, far.lon, NOW)).toBeNull();
        await loadModelsAtHer(far.lat, far.lon, NOW);
        expect(proxy.calls).toHaveLength(2);
        expect(peekModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 61 * 60_000)).toBeNull();
        await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 61 * 60_000);
        expect(proxy.calls).toHaveLength(3);
    });

    it('a series asked for just before a UTC day turns is not reused once its hours stop reaching now', async () => {
        const at = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
        const hoursFrom = (h: number) => [0, 1, 2].map((i) => at(h, 0) / 1000 + i * 3_600);
        const replyFrom = (h: number) => async (points: { lat: number; lon: number }[]) =>
            points.map(() => ({
                hourly: {
                    time: hoursFrom(h),
                    [`wind_speed_10m_${ICON}`]: [12, 12, 12],
                    [`wind_direction_10m_${ICON}`]: [200, 200, 200],
                },
            }));
        // 22:54Z: the request ends with the day, so its last hour is 23:00Z.
        proxy.reply = replyFrom(21);
        expect((await loadModelsAtHer(SOLENT.lat, SOLENT.lon, at(22, 54))).state).toBe('ready');
        expect(proxy.calls[0].params).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-07' });
        // 23:31Z is inside the hour's reuse, but past 23:00Z + 30 min: not reused.
        expect(peekModelsAtHer(SOLENT.lat, SOLENT.lon, at(23, 31))).toBeNull();
        proxy.reply = replyFrom(22);
        expect((await loadModelsAtHer(SOLENT.lat, SOLENT.lon, at(23, 31))).state).toBe('ready');
        expect(proxy.calls).toHaveLength(2);
        expect(proxy.calls[1].params).toMatchObject({ start_date: '2026-10-07', end_date: '2026-10-08' });
        // Still 23:31: the new one is reused.
        expect(peekModelsAtHer(SOLENT.lat, SOLENT.lon, at(23, 32))?.state).toBe('ready');
    });

    it('two calls at once share one request', async () => {
        const [a, b] = await Promise.all([
            loadModelsAtHer(MID_ATLANTIC.lat, MID_ATLANTIC.lon, NOW),
            loadModelsAtHer(MID_ATLANTIC.lat, MID_ATLANTIC.lon, NOW),
        ]);
        expect(a).toEqual(b);
        expect(proxy.calls).toHaveLength(1);
    });

    it('a failure backs off: no request within the minute, and the wait is reported', async () => {
        proxy.reply = null;
        expect(await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW)).toEqual({ state: 'failed', retryInMs: 60_000 });
        proxy.reply = goodReply;
        expect(await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 20_000)).toEqual({
            state: 'failed',
            retryInMs: 40_000,
        });
        expect(peekModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 20_000)).toEqual({ state: 'failed', retryInMs: 40_000 });
        expect(proxy.calls).toHaveLength(1);
        expect((await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 61_000)).state).toBe('ready');
        expect(proxy.calls).toHaveLength(2);
    });

    it('a 429 is rate-limited', async () => {
        proxy.reply = async () => {
            throw new Error('Weather service request failed (429)');
        };
        expect(await loadModelsAtHer(HAURAKI.lat, HAURAKI.lon, NOW)).toEqual({
            state: 'rate-limited',
            retryInMs: 60_000,
        });
    });

    it('offline: no request without a series; a series already held is used', async () => {
        vi.stubGlobal('navigator', { ...navigator, onLine: false });
        expect(await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW)).toEqual({ state: 'offline' });
        expect(proxy.calls).toHaveLength(0);
        vi.unstubAllGlobals();
        await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW);
        vi.stubGlobal('navigator', { ...navigator, onLine: false });
        expect((await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 60_000)).state).toBe('ready');
        expect(proxy.calls).toHaveLength(1);
    });

    it('an unsuffixed-only reply is no wind from any model: no-models, held like a series', async () => {
        proxy.reply = async (points) =>
            points.map(() => ({ hourly: { time: [T0 / 1000], wind_speed_10m: [12], wind_direction_10m: [200] } }));
        expect(await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW)).toEqual({ state: 'no-models' });
        expect(await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW + 60_000)).toEqual({ state: 'no-models' });
        expect(proxy.calls).toHaveLength(1);
    });

    it('a model with no speed but a real direction (the GFS trap) is missing, not calm', async () => {
        const result = await loadModelsAtHer(SOLENT.lat, SOLENT.lon, NOW);
        if (result.state !== 'ready') throw new Error(result.state);
        expect(result.spread.missing).toContain(UKMO);
        expect(Object.keys(result.spread.members)).toEqual([ICON, ECMWF]);
    });
});
