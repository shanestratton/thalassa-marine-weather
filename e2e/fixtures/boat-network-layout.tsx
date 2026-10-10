import React from 'react';
import { createRoot } from 'react-dom/client';
import { BoatHardwareIntegrations } from '../../components/vessel/BoatHardwareIntegrations';
import { PageHeader } from '../../components/ui/PageHeader';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const mode = params.get('mode') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');

/**
 * ?charts=<state> (127-C-d): the real Boat Pi section paired with Kestrel, a
 * fictional boat whose Pi sits at 192.168.4.20 in the Solent, answering the
 * chart vault's device routes as Pi update 3 will. Nothing leaves the page:
 * window.fetch answers for that one Pi (the browser lane's transport), signs
 * the identity challenge with a key made here, and records every request so
 * the spec can see which ones carried X-Thalassa-Chart-Device.
 *
 *   not-set-up  the code field                set-up   2 of 5 devices, the list
 *   wifi-only   reached over the tailnet       limit    a sixth device (409)
 *   dongle      the o-charts dongle out        old-pi   today's Pi: no device routes (404)
 *
 * A browser shows no mobile keyboard under automation, so the visual viewport
 * is modelled (as e2e/fixtures/stores-boxes.tsx does) under the app's real
 * keyboard guard: dispatch `test:keyboard` with a height.
 */
const charts = params.get('charts');
const PI = '192.168.4.20:3001';
/** Fictional: 43 base64url characters, the shape of the vault's 32-byte tokens. */
const TOKEN = 'kestrelFixtureChartToken' + 'z'.repeat(19);

interface KestrelPi {
    ready: boolean;
    token: string;
    requests: { method: string; path: string; url: string; header: string | null }[];
}
const kestrelPi: KestrelPi = { ready: false, token: TOKEN, requests: [] };
(window as unknown as { __kestrelPi: KestrelPi }).__kestrelPi = kestrelPi;

async function installKestrelPi(state: string): Promise<void> {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey));
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const deviceId = 'kestrel-pi-solent';
    localStorage.setItem(
        'thalassa_pi_pairing_v1',
        JSON.stringify({
            deviceId,
            boatName: 'Kestrel',
            publicKeySpki: b64(spki),
            fingerprint: 'KE:ST:RE:L0:SO:LE:NT:42',
            host: '192.168.4.20',
            pairedAt: '2026-10-10T09:00:00.000Z',
        }),
    );

    const now = Date.now();
    let enrolled = state === 'set-up' || state === 'dongle';
    const devices = enrolled
        ? [
              { id: 'dev-kestrel-phone', label: 'iPhone', enrolledAt: '2026-10-10T09:05:00.000Z' },
              { id: 'dev-kestrel-ipad', label: 'iPad', enrolledAt: '2026-10-10T09:20:00.000Z' },
          ]
        : [];
    if (enrolled) {
        const { saveChartDevice } = await import('../../services/PiPairingService');
        await saveChartDevice({ chartDeviceId: 'dev-kestrel-phone', token: TOKEN });
    }

    const reply = (status: number, body: unknown) =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status,
            headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' },
        });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.host !== PI) return realFetch(input, init);
        const method = (init?.method ?? 'GET').toUpperCase();
        const header = new Headers(init?.headers).get('X-Thalassa-Chart-Device');
        kestrelPi.requests.push({ method, path: url.pathname, url: url.href, header });
        const path = url.pathname;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        const withToken = header === TOKEN && enrolled;

        if (path === '/api/admin/status') {
            return reply(200, {
                status: 'ok',
                cache: { kvEntries: 1284, tileEntries: 5120, dbSizeMB: 212 },
                config: { supabaseConfigured: true },
            });
        }
        if (path === '/api/pair/challenge') {
            const timestamp = Date.now();
            const fields = ['challenge', String(body.nonce), String(timestamp), deviceId].join('|');
            const signature = new Uint8Array(
                await crypto.subtle.sign(
                    { name: 'ECDSA', hash: 'SHA-256' },
                    key.privateKey,
                    new TextEncoder().encode(fields),
                ),
            );
            return reply(200, { deviceId, timestamp, signature: b64(signature) });
        }
        if (path.startsWith('/api/enc/devices')) {
            if (state === 'old-pi') return reply(404, `<!DOCTYPE html><pre>Cannot ${method} ${path}</pre>`);
            if (state === 'wifi-only') return reply(403, { code: 'charts-boat-wifi-only' });
            if (path === '/api/enc/devices/status') {
                return reply(
                    200,
                    withToken
                        ? {
                              enrolled: true,
                              deviceId: 'dev-kestrel-phone',
                              devices: devices.length,
                              maxDevices: 5,
                              cells: 1025,
                              vault: state === 'dongle' ? 'decoder-down' : 'ready',
                          }
                        : { enrolled: false, devices: state === 'limit' ? 5 : 0, maxDevices: 5 },
                );
            }
            if (path === '/api/enc/devices/enrol' && method === 'POST') {
                if (state === 'limit') return reply(409, { code: 'chart-device-limit' });
                if (body.code !== 'HJKMN4PQRS') return reply(401, { code: 'chart-code-invalid' });
                enrolled = true;
                devices.push({
                    id: 'dev-kestrel-phone',
                    label: String(body.label),
                    enrolledAt: new Date().toISOString(),
                });
                return reply(200, { deviceId: 'dev-kestrel-phone', token: TOKEN });
            }
            if (!withToken) return reply(401, { code: 'chart-device-not-enrolled' });
            if (path === '/api/enc/devices' && method === 'GET') {
                return reply(200, {
                    devices: devices.map((device) => ({ ...device, lastSeenAt: new Date(now).toISOString() })),
                    maxDevices: 5,
                });
            }
            if (path === '/api/enc/devices/code' && method === 'POST') {
                return reply(200, { code: 'HJKMN4PQRS', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
            }
            const removed = path.match(/^\/api\/enc\/devices\/([A-Za-z0-9_-]+)$/);
            if (removed && method === 'DELETE') {
                const at = devices.findIndex((device) => device.id === removed[1]);
                if (at < 0) return reply(404, { code: 'chart-device-unknown' });
                devices.splice(at, 1);
                if (removed[1] === 'dev-kestrel-phone') enrolled = false;
                return reply(200, { removed: true });
            }
        }
        return reply(404, { error: 'Not in the Kestrel fixture' });
    };

    // The keyboard: the real app-wide guard over a modelled visual viewport.
    const viewport = new EventTarget();
    Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const cover = document.createElement('div');
    cover.setAttribute('data-testid', 'keyboard');
    Object.assign(cover.style, {
        position: 'fixed',
        bottom: '0',
        left: '0',
        right: '0',
        height: '0',
        display: 'none',
        background: '#334155',
        zIndex: '2147483647',
    });
    document.body.append(cover);
    window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
        Object.assign(viewport, { height: window.innerHeight - event.detail });
        cover.style.height = `${event.detail}px`;
        cover.style.display = event.detail ? 'block' : 'none';
        viewport.dispatchEvent(new Event('resize'));
    }) as EventListener);
    const { initGlobalKeyboardScroll } = await import('../../utils/keyboardScroll');
    initGlobalKeyboardScroll();
}

if (charts) await installKestrelPi(charts);

// Fresh browser contexts provide empty local storage. Keep the real settings
// subscription and Pi panel, but every settings save stays in this fixture.
// No app bootstrap, account, discovery, or physical boat is configured.
useSettingsStore.setState({
    settings: charts
        ? { ...DEFAULT_SETTINGS, piCacheEnabled: true, piCacheHost: '192.168.4.20', piCachePort: 3001 }
        : { ...DEFAULT_SETTINGS, piCacheEnabled: false, piCacheHost: '' },
    updateSettings: (patch) => {
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }));
    },
});

function Fixture() {
    return (
        <main className="flex h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            {pane && <aside className="h-full w-1/2 shrink-0 bg-slate-900 p-4 text-slate-300">Other tablet pane</aside>}
            <section
                className={`flex h-full min-h-0 min-w-0 flex-col ${pane ? 'w-1/2' : 'w-full'}`}
                data-testid="boat-network-pane"
                data-split-pane={pane ? 'vessel' : undefined}
            >
                <div className="shrink-0" data-testid="boat-network-header">
                    <PageHeader
                        title="Boat Network"
                        subtitle="The Pi & boat devices"
                        onBack={() => {}}
                        breadcrumbs={['Vessel', 'Boat Network']}
                    />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32" data-testid="boat-network-scroll">
                    <div className="mb-3 rounded-2xl border border-white/6 bg-white/3 p-4">
                        <p className="text-sm font-bold">Boat Network</p>
                        <p className="mt-1 text-xs text-slate-300">Pi, instruments &amp; weather cache</p>
                    </div>
                    <BoatHardwareIntegrations />
                    <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
                        <p className="text-sm font-bold">Charts on this phone</p>
                        <p className="mt-1 text-xs text-slate-300">No charts on this phone yet.</p>
                    </div>
                </div>
            </section>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
kestrelPi.ready = true;
