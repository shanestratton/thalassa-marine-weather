import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), sat: false }));
vi.mock('../services/supabase', () => ({
    supabase: { rpc: mock.rpc, auth: { getSession: mock.session } },
    supabaseUrl: 'https://fixture.invalid',
    supabaseAnonKey: 'fixture',
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.sat }));
import {
    readChartNoteWindow,
    retireChartNotes,
    chartNotesRequest,
    chartPhotoRequest,
} from '../services/community/ChartNotesService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const row = {
    id: '10000000-0000-4000-8000-000000000001',
    revision: '20000000-0000-4000-8000-000000000001',
    kind: 'hazard',
    latitude: -27,
    longitude: 153,
    message: 'Private until selected.',
    observed_date: '2026-10-01',
    expires_at: '2026-10-31T00:00:00Z',
    confirms: 0,
    denies: 0,
    my_vote: null,
    mine: false,
    reviewed: false,
    photo_id: null,
};
const bbox = [152, -28, 154, -26] as const;
const response = (server_now = '2026-10-17T00:00:00Z') => ({ notes: [row], server_now, truncated: false });
let mono = 100;
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    mono = 100;
    mock.sat = false;
    mock.rpc.mockReset();
    mock.session.mockReset();
    setAuthIdentityScope('a');
    mock.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: response(), error: null }) });
});
afterEach(() => {
    retireChartNotes();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
function defer() {
    let resolve!: (x: unknown) => void;
    return { promise: new Promise((r) => (resolve = r)), resolve };
}
describe('actual no-cache chart note source lease', () => {
    it('keeps exact positive results until release without extending TTL on read', async () => {
        const retired = vi.fn(),
            lease = await readChartNoteWindow(bbox, undefined, retired);
        expect(lease.notes[0]).toEqual(row);
        mono += 14999;
        expect(lease.isCurrent()).toBe(true);
        expect(lease.notes.length).toBe(1);
        mono++;
        expect(lease.isCurrent()).toBe(false);
        expect(lease.notes).toEqual([]);
        expect(retired).toHaveBeenCalledTimes(1);
        lease.release();
        expect(retired).toHaveBeenCalledTimes(1);
    });
    it('charges full request latency and earliest UTC expiry without trusting local wall clock', async () => {
        const d = defer();
        mock.rpc.mockReturnValue({ abortSignal: () => d.promise });
        const p = readChartNoteWindow(bbox);
        mono += 2000;
        d.resolve({ data: response('2026-10-30T23:59:57Z'), error: null });
        const lease = await p;
        expect(lease.isCurrent()).toBe(true);
        mono += 1000;
        expect(lease.isCurrent()).toBe(false);
    });
    it.each(['auth', 'abort', 'write', 'satellite', 'reverse'] as const)(
        'retires actual rows for %s transition',
        async (transition) => {
            const ctl = new AbortController(),
                lease = await readChartNoteWindow(bbox, ctl.signal);
            if (transition === 'auth') setAuthIdentityScope('b');
            else if (transition === 'abort') ctl.abort();
            else if (transition === 'write') retireChartNotes();
            else if (transition === 'satellite') mock.sat = true;
            else mono--;
            expect(lease.isCurrent()).toBe(false);
            expect(lease.notes).toEqual([]);
        },
    );
    it('never adopts late old intent, changed-account or mutation-racing results', async () => {
        for (const change of [() => setAuthIdentityScope('b'), () => retireChartNotes()]) {
            setAuthIdentityScope('a');
            const d = defer();
            mock.rpc.mockReturnValue({ abortSignal: () => d.promise });
            const p = readChartNoteWindow(bbox);
            change();
            d.resolve({ data: response(), error: null });
            await expect(p).rejects.toThrow('retired');
        }
    });
    it('caps simultaneous reservations and drops released data', async () => {
        const leases = await Promise.all(Array.from({ length: 4 }, () => readChartNoteWindow(bbox)));
        await expect(readChartNoteWindow(bbox)).rejects.toThrow('Too many');
        leases[0].release();
        const next = await readChartNoteWindow(bbox);
        expect(next.isCurrent()).toBe(true);
        next.release();
        leases.forEach((l) => l.release());
    });
    it('distinguishes missing backend from empty view and refuses WAN policy', async () => {
        mock.rpc.mockReturnValue({
            abortSignal: () => Promise.resolve({ data: null, error: { message: 'missing function' } }),
        });
        await expect(readChartNoteWindow(bbox)).rejects.toThrow('unavailable');
        mock.sat = true;
        await expect(readChartNoteWindow(bbox)).rejects.toThrow('normal internet');
    });
    it('a write retires earlier public cohorts even when rejected', async () => {
        const lease = await readChartNoteWindow(bbox);
        mock.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { message: 'denied' } }) });
        await expect(chartNotesRequest('report', { id: row.id })).rejects.toThrow();
        expect(lease.notes).toEqual([]);
    });
    it('routes chart photos only to separate authenticated no-store endpoint', async () => {
        mock.session.mockResolvedValue({ data: { session: { access_token: 'fixture' } } });
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('jpeg'));
        const ctl = new AbortController();
        await chartPhotoRequest(row.id, ctl.signal);
        expect(fetch.mock.calls[0][0]).toContain('/community-chart-photo?id=');
        expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', signal: ctl.signal });
    });
});
