import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), sat: false }));
vi.mock('../services/supabase', () => ({
    supabase: { rpc: mock.rpc, auth: { getSession: mock.session } },
    supabaseUrl: 'https://fixture.invalid',
    supabaseAnonKey: 'fixture-anon',
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.sat }));
import {
    reviewsRequest,
    listPlaceReviews,
    photoRequest,
    openPlaceReviews,
    REVIEWS_EVENT,
} from '../services/community/PlaceReviewsService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const row = {
    id: '10000000-0000-4000-8000-000000000001',
    holding: 'good',
    swell: 'calm',
    protection: ['N'],
    facilities: [],
    notes: 'Indicative only.',
    visited: null,
    updated_at: '2026-10-17T00:00:00Z',
    reviewed: false,
    photo_id: null,
};
const place = { id: 'osm-node12345', name: 'Test anchorage', kind: 'anchorage' as const };
beforeEach(() => {
    mock.rpc.mockReset();
    mock.session.mockReset();
    mock.sat = false;
    setAuthIdentityScope('a');
});
function defer() {
    let resolve!: (v: unknown) => void;
    return { promise: new Promise((r) => (resolve = r)), resolve };
}
function response(value: unknown) {
    mock.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: value, error: null }) });
}
describe('actual review API lifetime boundary', () => {
    it('rejects a late old-account result', async () => {
        const d = defer();
        mock.rpc.mockReturnValue({ abortSignal: () => d.promise });
        const p = reviewsRequest('mine', {});
        setAuthIdentityScope('b');
        d.resolve({ data: { notes: 'private-a' }, error: null });
        await expect(p).rejects.toThrow('retired');
    });
    it('rejects a queued intent after abort even if transport ignores signal', async () => {
        const d = defer();
        mock.rpc.mockReturnValue({ abortSignal: () => d.promise });
        const ctl = new AbortController();
        const p = reviewsRequest('mine', {}, ctl.signal);
        ctl.abort();
        d.resolve({ data: { notes: 'old' }, error: null });
        await expect(p).rejects.toThrow('retired');
    });
    it('does not mistake unavailable backend for empty reviews', async () => {
        mock.rpc.mockReturnValue({
            abortSignal: () => Promise.resolve({ data: null, error: { message: 'missing migration' } }),
        });
        await expect(listPlaceReviews(place)).rejects.toThrow('unavailable');
    });
    it('enforces bounded results and normal network policy', async () => {
        response({ reviews: Array(13).fill(row) });
        await expect(listPlaceReviews(place)).rejects.toThrow('Invalid');
        response({ reviews: [{ ...row, notes: 'x'.repeat(1201) }] });
        await expect(listPlaceReviews(place)).rejects.toThrow('Invalid');
        mock.sat = true;
        await expect(reviewsRequest('list', {})).rejects.toThrow('normal internet');
    });
    it('opens only supported public place identities', () => {
        const listener = vi.fn();
        window.addEventListener(REVIEWS_EVENT, listener);
        openPlaceReviews({ ...place, lat: 12, private: 'not forwarded' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(place);
        openPlaceReviews({ ...place, id: 'chart:licensed' });
        expect(listener).toHaveBeenCalledTimes(1);
        window.removeEventListener(REVIEWS_EVENT, listener);
    });
    it('photo fetch never uses signed/public URL and rejects late auth or abort', async () => {
        mock.session.mockResolvedValue({ data: { session: { access_token: 'fixture-token' } } });
        const d = defer();
        const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(d.promise as Promise<Response>);
        const ctl = new AbortController();
        const p = photoRequest(row.id, ctl.signal);
        await Promise.resolve();
        setAuthIdentityScope('b');
        d.resolve(new Response('jpeg'));
        await expect(p).rejects.toThrow('unavailable');
        expect(fetch.mock.calls[0][0]).toContain('/functions/v1/community-review-photo?id=');
        expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', signal: ctl.signal });
        fetch.mockRestore();
    });
});
