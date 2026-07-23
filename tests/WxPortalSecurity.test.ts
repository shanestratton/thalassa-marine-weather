import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import handler, { weatherPortalContentSecurityPolicy } from '../api/wx';

const ATTACK = `<img data-pwn src=x onerror="globalThis.pwned=1"><style data-pwn>body{display:none}</style>`;

describe('/api/wx public portal security', () => {
    it('serves a nonce-bound CSP and defensive browser headers', async () => {
        const response = await handler(new Request('https://thalassa.example/api/wx'));
        const html = await response.text();
        const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];

        expect(response.status).toBe(200);
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
        expect(html).toContain(`<style nonce="${nonce}">`);
        expect(response.headers.get('content-security-policy')).toBe(
            weatherPortalContentSecurityPolicy(nonce as string),
        );
        expect(response.headers.get('content-security-policy')).toContain("script-src-attr 'none'");
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
        expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
    });

    it('rejects mutating methods and does not return a body for HEAD', async () => {
        const rejected = await handler(new Request('https://thalassa.example/api/wx', { method: 'POST' }));
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get('allow')).toBe('GET, HEAD');

        const head = await handler(new Request('https://thalassa.example/api/wx', { method: 'HEAD' }));
        expect(await head.text()).toBe('');
        expect(head.headers.get('content-security-policy')).toContain("default-src 'none'");
    });

    it('does not contact storage for a data HEAD request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const response = await handler(new Request('https://thalassa.example/api/wx?data', { method: 'HEAD' }));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(await response.text()).toBe('');
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('bounds each pushed storage object and degrades only the bad object', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.includes('/current.json')) {
                return new Response('{"ignored":true}', {
                    headers: {
                        'content-type': 'application/json',
                        'content-length': String(512 * 1024 + 1),
                    },
                });
            }
            if (url.includes('/history.json')) {
                return new Response('[{"cpu":12}]', {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.includes('/forecast.json')) {
                return new Response('not-json', {
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response('{"date_local":"2026-07-24"}', {
                headers: { 'content-type': 'application/json' },
            });
        });

        const response = await handler(new Request('https://thalassa.example/api/wx?data=1'));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            current: null,
            history: [{ cpu: 12 }],
            forecast: null,
            report: { date_local: '2026-07-24' },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        for (const [, init] of fetchSpy.mock.calls) {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            expect(init?.cache).toBe('no-store');
        }
        fetchSpy.mockRestore();
    });

    it('renders hostile pushed storage strings as text under the exact embedded client', async () => {
        const response = await handler(new Request('https://thalassa.example/api/wx'));
        const html = await response.text();
        const payload = {
            current: {
                ts: new Date().toISOString(),
                om_health: { status: ATTACK },
                docker_om_api: ATTACK,
                residual_verdict: ATTACK,
                failed_units: [ATTACK],
                cpu_pct: ATTACK,
                load: [ATTACK],
                mem_used_pct: ATTACK,
                cpu_pkg_w: ATTACK,
                cpu_pkg_c: ATTACK,
                nvme_c: ATTACK,
                disk_weather: { used_gb: ATTACK, total_gb: ATTACK },
                uptime_h: ATTACK,
                net: { [ATTACK]: { rx_kbs: ATTACK, tx_kbs: ATTACK } },
                timers: { [ATTACK]: { last: ATTACK, result: ATTACK } },
                power_note: ATTACK,
            },
            history: [
                { t: new Date().toISOString(), cpu: 1, w: 2, tc: 3, rx: 4, tx: 5 },
                { t: new Date().toISOString(), cpu: 2, w: 3, tc: 4, rx: 5, tx: 6 },
            ],
            forecast: {
                generated_at: new Date().toISOString(),
                model_note: ATTACK,
                attribution: ATTACK,
                primary: 'icon',
                locations: {
                    station: {
                        name: ATTACK,
                        tz: ATTACK,
                        sun: {
                            time: ['2026-07-24'],
                            sunrise: ['2026-07-24T06:00'],
                            sunset: ['2026-07-24T18:00'],
                        },
                        models: {
                            icon: {
                                label: ATTACK,
                                cadence: ATTACK,
                                grid: [1],
                                current: {
                                    temperature_2m: ATTACK,
                                    feels_like: ATTACK,
                                    precipitation: ATTACK,
                                    cloud_cover: ATTACK,
                                    wind_direction_10m: 90,
                                    wind_speed_10m: ATTACK,
                                    wind_gusts_10m: ATTACK,
                                    pressure_msl: ATTACK,
                                    relative_humidity_2m: ATTACK,
                                    dew_point: ATTACK,
                                    weather_code: 0,
                                },
                                hourly: {
                                    time: ['2026-07-24T00:00', '2026-07-24T01:00'],
                                    temperature_2m: [20, 21],
                                    weather_code: [0, 0],
                                    cloud_cover: [0, 0],
                                    precipitation: [0, 0],
                                },
                                daily: {
                                    time: ['2026-07-24'],
                                    temperature_2m_max: [25],
                                    temperature_2m_min: [15],
                                    precipitation_sum: [0],
                                    weather_code: [0],
                                },
                                weights: { hostile: 1 },
                                weights_status: ATTACK,
                                member_labels: { hostile: ATTACK },
                                weights_scope: ATTACK,
                            },
                        },
                        tides: { station: ATTACK, events: [], error: ATTACK },
                    },
                },
            },
            report: {
                date_local: ATTACK,
                newport_nowcast: { samples: 0, note: ATTACK },
                newport_forecast24: { available: false, note: ATTACK },
                model_spread: { available: false, note: ATTACK },
                truth_note: ATTACK,
            },
        };

        const canvasContext = new Proxy(
            {
                createLinearGradient: () => ({ addColorStop: () => undefined }),
            } as Record<string, unknown>,
            {
                get(target, property) {
                    if (property in target) return target[property as string];
                    return () => undefined;
                },
                set(target, property, value) {
                    target[property as string] = value;
                    return true;
                },
            },
        );
        const dom = new JSDOM(html, {
            runScripts: 'dangerously',
            url: 'https://thalassa.example/api/wx',
            beforeParse(window) {
                window.fetch = vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => payload,
                }) as unknown as typeof window.fetch;
                window.setInterval = vi.fn(() => 0) as unknown as typeof window.setInterval;
                Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
                    configurable: true,
                    get: () => 640,
                });
                Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', {
                    configurable: true,
                    get: () => 190,
                });
                window.HTMLCanvasElement.prototype.getContext = (() =>
                    canvasContext) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
            },
        });

        await vi.waitFor(() => {
            expect(dom.window.document.getElementById('picker')?.textContent).toContain('<img data-pwn');
        });

        expect(dom.window.document.querySelector('[data-pwn]')).toBeNull();
        expect(dom.window.document.querySelector('[onerror]')).toBeNull();
        expect(dom.window.document.querySelectorAll('script')).toHaveLength(1);
        expect(dom.window.document.querySelectorAll('style')).toHaveLength(1);
        expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
        expect(dom.window.document.body.textContent).toContain('<style data-pwn>');
        dom.window.close();
    });
});
