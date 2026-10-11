/**
 * AvNav's o-charts pictures stay on the Pi in 127 (127-C-b decision 11).
 *
 * Mapbox fetches non-Mapbox raster tiles with a plain fetch(), and the iOS
 * WebView keeps a GET 200 in its disk cache unless the response says
 * no-store, which nothing on our side can force. A picture of a licensed
 * chart on the phone's disk is exactly what o-charts' terms forbid ("Storing
 * unencrypted data on any medium ... is strictly prohibited"), so the phone no
 * longer asks for them: DRM charts are dropped from AvNav's chart list, the
 * provider's token script is never loaded, and nothing is encrypted. Open
 * AvNav charts (mbtiles, gemf) are unchanged. For the day it is switched back
 * on, the tile host must be the boat's own LAN host, never the WAN host or the
 * tailnet. Fictional hosts and charts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@capacitor/core')>()),
    CapacitorHttp: { get: http.get, request: http.get },
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: { set: vi.fn(async () => undefined), get: vi.fn(async () => ({ value: null })) },
}));

const LAN = '192.168.50.7';
const WAN = '10.8.0.20';
const TOKEN_SCRIPT = `window.avnav=window.avnav||{};${' '.repeat(1100)}`;

function chartList(host: string) {
    return {
        status: 'OK',
        items: [
            {
                name: 'oeuSENC-ZZ-2026-1-0',
                chartKey: 'CSI_oeuSENC-ZZ-2026-1-0-base-linux',
                url: `http://${host}:8083/charts/CSI_oeuSENC-ZZ-2026-1-0-base-linux`,
                tokenUrl: `http://${host}:8083/tokens/?request=script`,
                minzoom: 3,
                maxzoom: 17,
            },
            {
                name: 'Chesapeake.mbtiles',
                chartKey: 'int@Chesapeake.mbtiles',
                url: '/chart/int@Chesapeake.mbtiles',
                minzoom: 4,
                maxzoom: 16,
            },
        ],
    };
}

let requested: string[] = [];
let scripts = 0;

async function load() {
    vi.resetModules();
    vi.stubEnv('DEV', false);
    return import('../services/AvNavService');
}

beforeEach(() => {
    localStorage.clear();
    requested = [];
    scripts = 0;
    http.get.mockReset().mockImplementation(async ({ url }: { url: string }) => {
        requested.push(url);
        return {
            status: 200,
            url,
            data: TOKEN_SCRIPT,
            headers: { 'Content-Type': 'application/javascript' },
        };
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            requested.push(url);
            const host = new URL(url).hostname;
            if (/avnav_navi\.php|\/api\/list/.test(url))
                return { ok: true, text: async () => JSON.stringify(chartList(host)) } as Response;
            throw new Error(`no route for ${url}`);
        }),
    );
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
        if (tag.toLowerCase() === 'script') scripts += 1;
        return createElement(tag, options);
    }) as typeof document.createElement);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as { avnav?: unknown }).avnav;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AvNav o-charts pictures are switched off on the phone', () => {
    it('keeps only the open chart: the DRM chart never enters the list and its token script is never fetched', async () => {
        const { AvNavService, AVNAV_OCHARTS_ON_PHONE } = await load();
        expect(AVNAV_OCHARTS_ON_PHONE).toBe(false);
        AvNavService.configure(LAN, 8080, 'avnav');
        await (AvNavService as unknown as { fetchAvNavCharts: () => Promise<void> }).fetchAvNavCharts();
        await settle();
        const charts = AvNavService.getCharts();
        expect(charts.map((c) => c.name)).toEqual(['Chesapeake']);
        expect(charts.some((c) => c.isDrm)).toBe(false);
        expect(requested.filter((url) => url.includes('/tokens/'))).toEqual([]);
        expect(scripts).toBe(0);
    });

    it('encrypts nothing, even with a provider on the page', async () => {
        const { encryptOchartsUrl } = await load();
        (window as unknown as { avnav: unknown }).avnav = {
            ochartsProvider: {
                encryptUrl: () => `encrypted/${'a'.repeat(32)}/12/${'b'.repeat(32)}/${'c'.repeat(64)}`,
            },
        };
        expect(encryptOchartsUrl(`http://${LAN}:8083/charts/CSI_oeuSENC-ZZ-2026-1-0-base-linux/10/942/614.png`)).toBe(
            null,
        );
    });

    it('a legacy saved WAN host never fetches or lists an o-charts tile on any host', async () => {
        localStorage.setItem('avnav_wan_host', WAN);
        const { AvNavService } = await load();
        AvNavService.configure(LAN, 8080, 'avnav', WAN);
        // As connect() leaves it after the LAN probe fails and the WAN host answers.
        (AvNavService as unknown as { activeHost: string }).activeHost = WAN;
        await (AvNavService as unknown as { fetchAvNavCharts: () => Promise<void> }).fetchAvNavCharts();
        await settle();
        expect(requested.filter((url) => url.includes('/charts/CSI_'))).toEqual([]);
        expect(requested.filter((url) => url.includes('/tokens/'))).toEqual([]);
        expect(AvNavService.getCharts().some((c) => c.tilesUrl.includes('/charts/CSI_'))).toBe(false);
    });

    it('allows o-charts tiles only from the boat LAN host, never the WAN host, a public IP or the tailnet', async () => {
        const { ochartsTileHostAllowed } = await load();
        expect(ochartsTileHostAllowed(LAN, LAN)).toBe(true);
        expect(ochartsTileHostAllowed('calypso.local', 'calypso.local')).toBe(true);
        expect(ochartsTileHostAllowed(WAN, LAN)).toBe(false);
        expect(ochartsTileHostAllowed('203.0.113.9', '203.0.113.9')).toBe(false);
        expect(ochartsTileHostAllowed('100.100.1.2', '100.100.1.2')).toBe(false);
        expect(ochartsTileHostAllowed('100.64.0.1', '100.64.0.1')).toBe(false);
        expect(ochartsTileHostAllowed('', '')).toBe(false);
    });
});
