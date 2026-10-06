/**
 * The Thalassa Ocean page's client helpers, with FICTIONAL data: the tooltip
 * stays inside the map, the load timeout counts only visible time, busy
 * areas page their rows (and say when they are cut short), and a blurred row
 * is never drawn as a point even if one were sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeTip, visibleTimeout } from '../../src/ocean/mapLayers';
import { fetchRowsAll, parseContext, parseRow, parseSummary } from '../../src/ocean/oceanApi';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('placeTip', () => {
    const box = { w: 373, h: 589 };
    const size = { w: 238, h: 80 };

    it('keeps a pinned tip on a phone inside the map, both ways', () => {
        // The measured failure: a tap at x=181 put a 238 px tip's right edge at 419 of 373.
        const at = placeTip({ x: 181, y: 300, left: false, below: false }, size, box);
        expect(at.x).toBeGreaterThanOrEqual(8);
        expect(at.x + size.w).toBeLessThanOrEqual(box.w - 8);
        const top = placeTip({ x: 20, y: 10, left: false, below: false }, size, box);
        expect(top.y).toBeGreaterThanOrEqual(8);
        const corner = placeTip({ x: 370, y: 585, left: true, below: true }, size, box);
        expect(corner.x + size.w).toBeLessThanOrEqual(box.w - 8);
        expect(corner.y + size.h).toBeLessThanOrEqual(box.h - 8);
    });

    it('sits beside the pointer when there is room', () => {
        expect(placeTip({ x: 100, y: 300, left: false, below: false }, size, { w: 1200, h: 800 })).toEqual({
            x: 112,
            y: 210,
        });
        expect(placeTip({ x: 900, y: 300, left: true, below: true }, size, { w: 1200, h: 800 })).toEqual({
            x: 650,
            y: 314,
        });
    });
});

describe('visibleTimeout', () => {
    it('counts only time the page is visible, so a background tab never gives up on the map', () => {
        vi.useFakeTimers();
        let state: DocumentVisibilityState = 'hidden';
        const fired = vi.fn();
        const stop = visibleTimeout(25_000, fired, () => state);
        vi.advanceTimersByTime(60_000); // a minute in a background tab
        expect(fired).not.toHaveBeenCalled();
        state = 'visible';
        vi.advanceTimersByTime(24_000);
        expect(fired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2_000);
        expect(fired).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_000);
        expect(fired).toHaveBeenCalledTimes(1);
        stop();
    });

    it('can be cancelled', () => {
        vi.useFakeTimers();
        const fired = vi.fn();
        const stop = visibleTimeout(5_000, fired, () => 'visible');
        stop();
        vi.advanceTimersByTime(10_000);
        expect(fired).not.toHaveBeenCalled();
    });
});

const row = (i: number) => ({
    id: `0f6f2d0e-5d0b-4c4e-9a51-${String(i).padStart(12, '0')}`,
    group: 'whale',
    sci: 'Megaptera novaeangliae',
    name: 'Humpback whale',
    count: 1,
    calf: false,
    time: new Date(Date.UTC(2026, 7, 1) - i * 600_000).toISOString(),
    lat: -27.055,
    lon: 153.645,
    uncertainty_m: 790,
    generalised: false,
    credit: null,
});

function pages(total: number) {
    const all = Array.from({ length: total }, (_, i) => row(i));
    const asked: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            asked.push(url);
            const q = new URL(url, 'https://ocean.thalassawx.app').searchParams;
            const before = q.get('before');
            const start = before ? all.findIndex((r) => r.time === before && r.id === q.get('before_id')) + 1 : 0;
            const rows = all.slice(start, start + 200);
            const last = rows.length === 200 ? rows[199] : null;
            return new Response(
                JSON.stringify({
                    v: 1,
                    status: 'ok',
                    rows,
                    next: last ? { before: last.time, before_id: last.id } : null,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }),
    );
    return asked;
}

describe('fetchRowsAll', () => {
    it('follows next until the box is complete', async () => {
        const asked = pages(450);
        const got = await fetchRowsAll([-28, 153, -27, 154]);
        expect(got).not.toBeNull();
        expect(got!.rows).toHaveLength(450);
        expect(got!.complete).toBe(true);
        expect(asked).toHaveLength(3);
        expect(asked[1]).toMatch(/before=.*&before_id=/);
    });

    it('stops at the page cap and says the box was cut short', async () => {
        const asked = pages(2000);
        const got = await fetchRowsAll([-28, 153, -27, 154], 3);
        expect(got!.rows).toHaveLength(600);
        expect(got!.complete).toBe(false);
        expect(asked).toHaveLength(3);
    });
});

describe('parsers', () => {
    it('never draws a blurred row as a point, even if one were sent', () => {
        expect(parseRow({ ...row(1), generalised: true, lat: -27.45, lon: 153.35 })).toBeNull();
        expect(parseRow(row(1))).not.toBeNull();
    });

    it('reads whether the cells were cut short', () => {
        const base = { v: 1, status: 'ok', totals: { sightings: 1 }, cells: [], species: [], recent: [] };
        const on = parseSummary({ ...base, cells_truncated: true });
        const off = parseSummary(base);
        expect(on.status === 'ok' && on.summary.cellsTruncated).toBe(true);
        expect(off.status === 'ok' && off.summary.cellsTruncated).toBe(false);
    });

    it('reads the regional notes and each dataset licence link from the context file', () => {
        const ctx = parseContext({
            schema: 'thalassa-ocean-context',
            v: 1,
            region: { id: 'au-east', name: 'East coast of Australia' },
            notes: ['Fixture regional note.'],
            modification: 'Fixture: aggregated into cells.',
            species: [],
            datasets: [
                {
                    id: 'a',
                    title: 'Fixture survey',
                    licence: 'CC BY 4.0',
                    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                },
                { id: 'b', title: 'Fixture two', licence: 'CC0 1.0', licenceUrl: 'javascript:alert(1)' },
            ],
        });
        expect(ctx!.notes).toEqual(['Fixture regional note.']);
        expect(ctx!.modification).toBe('Fixture: aggregated into cells.');
        expect(ctx!.datasets[0].licenceUrl).toBe('https://creativecommons.org/licenses/by/4.0/');
        // Only the two known licence deeds are linked; anything else falls back to the deed for its name.
        expect(ctx!.datasets[1].licenceUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    });
});
