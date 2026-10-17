import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ route: vi.fn(), land: vi.fn(), cold: vi.fn() }));
vi.mock('../services/InshoreRouter', () => ({ tryInshoreRoute: m.route }));
vi.mock('../services/routing/landBackstop', () => ({ inshoreRouteCrossesLand: m.land }));
vi.mock('../services/traceRecheck', () => ({ recheckTrace: m.cold }));
import { autoTraceLeg } from '../services/routing/autoTraceLeg';
import { resolveRouteConstraints } from '../services/routing/routeConstraints';
import type { TracePoint } from '../services/routeTracer';

const pins = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.02 },
];
const input = () => ({
    points: pins,
    legIndex: 0,
    draftM: 1.8,
    airDraftM: 10,
    departureMs: Date.parse('2026-10-17T06:00:00Z'),
    satelliteMode: false,
    signal: new AbortController().signal,
    shouldContinue: () => true,
});
function engine(points: TracePoint[] = pins) {
    const mask = points.slice(1).map(() => false);
    return {
        polyline: points.map((p) => [p.lon, p.lat]),
        distanceNM: 1.2,
        cautionMask: mask,
        canalMask: mask,
        channelMask: mask,
        offshoreMask: mask,
    };
}
beforeEach(() => {
    m.route.mockReset().mockResolvedValue(engine());
    m.land.mockReset().mockResolvedValue({ status: 'verified', crossesLand: false });
    m.cold.mockReset().mockImplementation(async (p: TracePoint[]) => ({
        ok: true,
        verification: { legGrades: p.slice(1).map(() => 'clear') },
    }));
});
afterEach(() => vi.useRealTimers());

describe('strict per-leg Auto edits', () => {
    it('refuses unsupported global, polar and dateline requests before provider work', async () => {
        for (const points of [
            [pins[0], { lat: 0, lon: 10 }],
            [
                { lat: 84, lon: 0 },
                { lat: 84, lon: 0.1 },
            ],
            [
                { lat: 0, lon: 179.9 },
                { lat: 0, lon: -179.9 },
            ],
        ])
            await expect(autoTraceLeg({ ...input(), points })).rejects.toThrow('regional legs');
        expect(m.route).not.toHaveBeenCalled();
    });
    it('refuses a wrapping worker curve before it becomes a global linear chord', async () => {
        m.route.mockResolvedValue(engine([pins[0], { lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }, pins[1]]));
        await expect(autoTraceLeg(input())).rejects.toThrow('unsupported regional, dateline or polar');
        expect(m.land).not.toHaveBeenCalled();
    });
    it('does not trust a small reported distance for an almost-global worker curve', async () => {
        m.route.mockResolvedValue(engine([pins[0], { lat: 0, lon: 170 }, pins[1]]));
        await expect(autoTraceLeg(input())).rejects.toThrow('unsupported regional');
        expect(m.land).not.toHaveBeenCalled();
    });
    it('uses the supplied leg clock, no tide credit, a fresh whole final sweep and preserves user terminals', async () => {
        const original: TracePoint[] = [pins[0], { lat: 0.005, lon: 0.01 }, pins[1]];
        m.route.mockResolvedValue(engine(original));
        const result = await autoTraceLeg(input());
        expect(result.points).toEqual([pins[0], { ...original[1], shape: true }, pins[1]]);
        expect(pins).toEqual([
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.02 },
        ]);
        expect(m.route.mock.calls[0][4]).toBe('safest');
        expect(m.route.mock.calls[0][5]).toMatchObject({ departureMs: input().departureMs, tideCeilings: [] });
        expect(m.cold).toHaveBeenCalledWith(original, {
            departureMs: input().departureMs,
            signal: expect.any(AbortSignal),
        });
        expect(m.cold.mock.calls[0][1]).not.toHaveProperty('priorVerification');
    });
    it('checks the post-RDP chord and refuses if simplification cuts across an obstacle', async () => {
        const original = [pins[0], { lat: 0.0001, lon: 0.01 }, pins[1]];
        m.route.mockResolvedValue(engine(original));
        m.cold.mockImplementation(async (p: TracePoint[]) => ({
            ok: false,
            reason: p.length === 2 ? 'Chord crosses land' : 'unexpected',
        }));
        await expect(autoTraceLeg(input())).rejects.toThrow('fresh chart check');
        expect(m.land.mock.calls[0][0]).toEqual([
            [0, 0],
            [0.02, 0],
        ]);
        expect(m.cold.mock.calls[0][0]).toEqual(pins);
    });
    it.each(['caution', 'danger', 'unknown'])(
        'refuses the fresh %s grade rather than retaining an acknowledged clearance',
        async (grade) => {
            m.cold.mockResolvedValue({ ok: true, verification: { legGrades: [grade] } });
            await expect(autoTraceLeg(input())).rejects.toThrow('not completely clear');
        },
    );
    it('refuses a missing final grade', async () => {
        m.cold.mockResolvedValue({ ok: true, verification: { legGrades: [] } });
        await expect(autoTraceLeg(input())).rejects.toThrow('not completely clear');
    });
    it.each([
        { status: 'unavailable', crossesLand: false },
        { status: 'verified', crossesLand: true },
    ])('refuses incomplete or land-crossing final backstops', async (verdict) => {
        m.land.mockResolvedValue(verdict);
        await expect(autoTraceLeg(input())).rejects.toThrow('land check');
        expect(m.cold).not.toHaveBeenCalled();
    });
    it('refuses missing masks, malformed coordinates and charted land', async () => {
        m.route.mockResolvedValue({ ...engine(), channelMask: undefined });
        await expect(autoTraceLeg(input())).rejects.toThrow('complete route masks');
        m.route.mockResolvedValue({
            ...engine(),
            polyline: [
                [0, 0],
                [NaN, 0],
            ],
        });
        await expect(autoTraceLeg(input())).rejects.toThrow('invalid geometry');
        m.route.mockResolvedValue({ ...engine(), hardLand: { awayM: 20 } });
        await expect(autoTraceLeg(input())).rejects.toThrow('charted land');
    });
    it('does not replace a selected pin with a snapped route endpoint', async () => {
        m.route.mockResolvedValue(engine([{ lat: 0.001, lon: 0 }, pins[1]]));
        await expect(autoTraceLeg(input())).rejects.toThrow('retain both selected pins');
    });
    it('does not download replacement charts or try a straight/tidal fallback on coverage refusal', async () => {
        m.route.mockResolvedValue({ error: 'Missing detailed chart', code: 'coverage-gap' });
        await expect(autoTraceLeg(input())).rejects.toThrow("Licensed charts come only from your boat's Pi");
        expect(m.route).toHaveBeenCalledTimes(1);
        expect(m.cold).not.toHaveBeenCalled();
    });
    it('makes no engine/provider request in Satellite Mode', async () => {
        await expect(autoTraceLeg({ ...input(), satelliteMode: true })).rejects.toThrow('Satellite Mode');
        expect(m.route).not.toHaveBeenCalled();
    });
    it('refuses a new leg that crosses an original leave-side half-line', async () => {
        const destination = { lat: 0, lon: 0.04 };
        const marks = resolveRouteConstraints(
            pins[0],
            [{ lat: 0, lon: 0.02, leaveSide: 'port', standOffM: 50 }],
            destination,
        )!;
        const side = { ...marks.points[1], constraint: marks.canonicalVias[0] };
        m.route.mockResolvedValue(engine([pins[0], { lat: 0.01, lon: 0.025 }, side]));
        await expect(autoTraceLeg({ ...input(), points: [pins[0], side, destination] })).rejects.toThrow(
            'required mark',
        );
        expect(m.land).not.toHaveBeenCalled();
    });
    it('stops its waiter and signals the worker when a current-request fence changes', async () => {
        vi.useFakeTimers();
        let current = true;
        m.route.mockReturnValue(new Promise(() => {}));
        const pending = autoTraceLeg({ ...input(), shouldContinue: () => current });
        const rejection = expect(pending).rejects.toThrow('request changed');
        await vi.advanceTimersByTimeAsync(100);
        current = false;
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        expect(m.route.mock.calls[0][5].signal.aborted).toBe(true);
        expect(m.cold).not.toHaveBeenCalled();
    });
    it('bounds an uncancellable native await to one 60-second lifetime', async () => {
        vi.useFakeTimers();
        m.route.mockReturnValue(new Promise(() => {}));
        const pending = autoTraceLeg(input());
        const rejection = expect(pending).rejects.toThrow('time expired');
        await vi.advanceTimersByTimeAsync(60_000);
        await rejection;
        expect(m.route.mock.calls[0][5].signal.aborted).toBe(true);
    });
});
