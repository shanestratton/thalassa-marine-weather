import { expect, test } from '@playwright/test';

test('a public-only offshore worker loads, returns an unverified route, and leaves the page running', async ({
    page,
}) => {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/e2e/fixtures/offshore-worker.html')
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><button id="probe">Page remains live</button></body></html>',
            });
        return route.continue();
    });
    await page.goto('/e2e/fixtures/offshore-worker.html');
    const result = await page.evaluate(async () => {
        const hostUrl = '/services/routing/offshoreWorkerHost.ts';
        const { runOffshoreHosted } = (await import(
            /* @vite-ignore */ hostUrl
        )) as typeof import('../services/routing/offshoreWorkerHost');
        const NativeWorker = window.Worker;
        let workers = 0;
        class CountedWorker extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                workers++;
            }
        }
        Object.defineProperty(window, 'Worker', { configurable: true, value: CountedWorker });
        const frame = (value: number) => new Float32Array(9).fill(value);
        let ticks = 0,
            longest = 0,
            last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            longest = Math.max(longest, now - last);
            last = now;
            ticks++;
        }, 4);
        try {
            const candidate = await runOffshoreHosted({
                origin: { lat: 0, lon: -30 },
                destination: { lat: 0, lon: -18 },
                departureTime: '2026-10-17T00:00:00Z',
                polar: {
                    angles: [40, 90, 180],
                    windSpeeds: [5, 20],
                    matrix: [
                        [6, 7],
                        [6, 7],
                        [6, 7],
                    ],
                },
                wind: {
                    u: Array.from({ length: 168 }, () => frame(5)),
                    v: Array.from({ length: 168 }, () => frame(0)),
                    speed: Array.from({ length: 168 }, () => frame(5)),
                    width: 3,
                    height: 3,
                    lats: [-2, 0, 2],
                    lons: [-32, -24, -16],
                    north: 2,
                    south: -2,
                    west: -32,
                    east: -16,
                    totalHours: 168,
                    refTime: '2026-10-17T00:00:00Z',
                },
                bathymetry: {
                    south: -2,
                    north: 2,
                    west: -32,
                    east: -16,
                    latStep: 2,
                    lonStep: 8,
                    rows: 3,
                    cols: 3,
                    data: frame(-2000),
                },
                environment: {
                    departureMs: Date.parse('2026-10-17T00:00:00Z'),
                    currentVectors: null,
                    waves: null,
                    cyclones: null,
                },
                config: { timeStepHours: 0.5, maxHours: 168, bearingCount: 144, powerVessel: true, motoringSpeed: 6 },
                deadlineMs: Date.now() + 60_000,
            });
            return {
                workers,
                ticks,
                longest,
                verification: candidate?.verification,
                points: candidate?.result.route.length,
                motorHours: candidate?.result.sailingStats?.motorHours,
                fronts: candidate?.result.isochrones.length,
            };
        } finally {
            clearInterval(timer);
            Object.defineProperty(window, 'Worker', { configurable: true, value: NativeWorker });
        }
    });
    await test
        .info()
        .attach('offshore-worker-evidence', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.workers).toBe(1);
    expect(result.verification).toBe('unverified-public-data');
    expect(result.points).toBeGreaterThanOrEqual(2);
    expect(result.motorHours).toBeGreaterThan(0);
    expect(result.fronts).toBe(0);
    expect(result.ticks).toBeGreaterThan(5);
    expect(result.longest).toBeLessThan(process.env.CI ? 250 : 150);
});
