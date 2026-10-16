import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, metar, ndbcLatest } from './observationFixtures';
const state = vi.hoisted(() => ({ native: true, satellite: false, read: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => state.native, getPlatform: () => 'ios' } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => state.satellite }));
vi.mock('../services/weather/observations/transport', () => ({ readObservation: state.read }));
vi.mock('../services/weather/buoys/providers/ndbc', () => ({ ndbcOwner: () => null }));
const point = { lat: 30, lon: -150 };
const catalogue = JSON.stringify([
    { icaoId: 'ZZ01', site: 'Fictional airport', lat: 30.01, lon: -150, siteType: ['METAR'] },
]);
const ndbc = ndbcLatest(['ZZ001 30.02 -150 2026 10 16 11 30 90 5 8 1008 20']);
let feed: typeof import('../services/weather/observations/feed');
let identity: typeof import('../services/authIdentityScope');
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    state.native = true;
    state.satellite = false;
    state.read.mockReset();
    state.read.mockImplementation(async ({ url }: { url: string }) =>
        url.endsWith('.gz') ? catalogue : url.includes('/metar?') ? JSON.stringify([metar()]) : ndbc,
    );
    identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('observation-fixture-a');
    feed = await import('../services/weather/observations/feed');
});
afterEach(() => {
    identity.setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('observation feed integration', () => {
    it('accepts a real inspection at zero latitude/longitude without accepting missing station positions', async () => {
        const result = await feed.loadNearbyObservations({ lat: 0, lon: 0 });
        expect(result.point).toEqual({ lat: 0, lon: 0 });
        expect(result.availability.ndbc).toBe('available');
    });
    it('deduplicates demand reads and sends only fixed catalogue URLs or public station IDs', async () => {
        const [one, two] = await Promise.all([feed.loadNearbyObservations(point), feed.loadNearbyObservations(point)]);
        expect(state.read).toHaveBeenCalledTimes(3);
        expect(one.rows).toHaveLength(2);
        expect(two.rows).toHaveLength(2);
        expect(one.availability).toEqual({ ndbc: 'available', 'awc-metar': 'available' });
        const urls = state.read.mock.calls.map(([request]) => new URL(request.url));
        expect(
            urls.every(
                (u) =>
                    !u.searchParams.has('latitude') && !u.searchParams.has('longitude') && !u.searchParams.has('bbox'),
            ),
        ).toBe(true);
        expect(urls.find((u) => u.pathname.endsWith('metar'))?.searchParams.get('ids')).toBe('ZZ01');
    });
    it('retains true retrieval time on a cached read and serves session history without Satellite WAN', async () => {
        const first = await feed.loadNearbyObservations(point);
        const station = first.rows[0];
        vi.setSystemTime(NOW + 9 * 60000);
        const again = await feed.loadNearbyObservations(point);
        expect(again.rows[0].retrievedAtMs).toBe(NOW);
        expect(state.read).toHaveBeenCalledTimes(3);
        state.satellite = true;
        vi.setSystemTime(NOW + 20 * 60000);
        const offline = await feed.loadNearbyObservations(point);
        expect(offline.cachedOnly).toBe(true);
        expect(offline.rows).toHaveLength(2);
        expect(state.read).toHaveBeenCalledTimes(3);
        expect((await feed.loadObservationHistory(station, 72)).cachedOnly).toBe(true);
        expect(state.read).toHaveBeenCalledTimes(3);
    });
    it('makes no calls on web and keeps unavailable separate from no recent reading', async () => {
        state.native = false;
        const result = await feed.loadNearbyObservations(point);
        expect(result.availability).toEqual({ ndbc: 'native-required', 'awc-metar': 'native-required' });
        expect(state.read).not.toHaveBeenCalled();
    });
    it('backs off failures; a failed provider does not erase the other provider', async () => {
        state.read.mockImplementation(async ({ url }: { url: string }) => {
            if (url.includes('ndbc')) throw new Error('429');
            return url.endsWith('.gz') ? catalogue : JSON.stringify([metar()]);
        });
        const first = await feed.loadNearbyObservations(point);
        expect(first.availability).toEqual({ ndbc: 'failed', 'awc-metar': 'available' });
        expect(first.rows).toHaveLength(1);
        await feed.loadNearbyObservations(point);
        expect(state.read).toHaveBeenCalledTimes(3);
    });
    it('holds native concurrency at two when many independent station histories are queued', async () => {
        const initial = await feed.loadNearbyObservations(point);
        const station = initial.rows.find((row) => row.provider === 'awc-metar')!;
        let active = 0,
            maximum = 0;
        state.read.mockImplementation(async ({ url }: { url: string }) => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
            return JSON.stringify([metar({ icaoId: new URL(url).searchParams.get('ids') })]);
        });
        await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                feed.loadObservationHistory({ ...station, id: `AA${String(i).padStart(2, '0')}` }, 72),
            ),
        );
        expect(maximum).toBe(2);
    });
    it('preserves400-result partial coverage and filters unrequested station identities', async () => {
        state.read.mockImplementation(async ({ url }: { url: string }) =>
            url.endsWith('.gz')
                ? catalogue
                : url.includes('/metar?')
                  ? JSON.stringify(Array.from({ length: 400 }, (_, i) => metar({ icaoId: i === 0 ? 'ZZ01' : 'ZZ99' })))
                  : ndbc,
        );
        const result = await feed.loadNearbyObservations(point);
        expect(result.partial).toBe(true);
        expect(result.rows.filter((r) => r.provider === 'awc-metar')).toHaveLength(1);
    });
    it('aborts unshared requests on close and never publishes old-account replies', async () => {
        const signals: AbortSignal[] = [];
        const releases: (() => void)[] = [];
        state.read.mockImplementation(
            (_request: unknown, signal: AbortSignal) =>
                new Promise<string>((resolve, reject) => {
                    signals.push(signal);
                    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                    releases.push(() => resolve(ndbc));
                }),
        );
        const controller = new AbortController();
        const pending = feed.loadNearbyObservations(point, controller.signal);
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        await expect(pending).rejects.toThrow(/cancelled/);
        expect(signals.every((s) => s.aborted)).toBe(true);
        const second = feed.loadNearbyObservations(point);
        await Promise.resolve();
        await Promise.resolve();
        identity.setAuthIdentityScope('observation-fixture-b');
        releases.forEach((release) => release());
        await expect(second).rejects.toThrow(/cancelled|account/);
    });
});
