import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';

/**
 * This phone's place in the boat's chart vault (127-C-d, app half).
 *
 * Pi update 3 serves charts only to devices it has enrolled by code: each one
 * sends `X-Thalassa-Chart-Device: <token>` on /api/enc/*. These tests pin the
 * phone's side of that:
 *
 *   - the token lives in the Keychain under 'thalassa-pi-chart-device' only,
 *     read once per launch and then held in memory;
 *   - it is dropped on Forget, on a 'chart-device-removed' answer, and never
 *     sent to a Pi it was not issued by;
 *   - it never appears in a URL, a log line or localStorage;
 *   - against today's Pi (update 2: no /api/enc/devices routes, header
 *     ignored) the row reads "needs its next update" and charts keep loading
 *     exactly as now (decision 15: the 127 app goes on the phone first).
 *
 * Everything here is fictional: Kestrel, her Pi at 192.168.4.20, the Solent.
 */

const KEY = 'thalassa-pi-chart-device';
const HEADER = 'X-Thalassa-Chart-Device';
const BASE = 'https://192.168.4.20:3001';
/** 43 base64url characters, the shape of 32 random bytes. Unique, so a scan can find it. */
const TOKEN = 'kestrelSolentChartToken_' + 'x'.repeat(19);
const PI_ID = 'kestrel-pi-7f3a';

const tls = vi.hoisted(() => ({ request: vi.fn(), pairingFetch: vi.fn() }));
vi.mock('../services/piTls', () => ({
    piRequest: tls.request,
    piPairingFetch: tls.pairingFetch,
    isPinnedTransportAvailable: () => true,
}));

const keychain = vi.hoisted(() => {
    const store = new Map<string, string>();
    return {
        store,
        native: { value: true },
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
            store.delete(key);
        }),
    };
});
vi.mock('../services/auth/secureStorage', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/auth/secureStorage')>();
    const allowed = (key: string) => {
        if (!(real.SECURE_STORAGE_KEYS as readonly string[]).includes(key)) throw new Error('not allowed');
    };
    return {
        ...real,
        usesNativeSecureStorage: () => keychain.native.value,
        getSecureValue: (key: string) => (allowed(key), keychain.get(key)),
        setSecureValue: (key: string, value: string) => (allowed(key), keychain.set(key, value)),
        removeSecureValue: (key: string) => (allowed(key), keychain.remove(key)),
    };
});

vi.mock('../services/PiCacheService', () => ({ piCache: { baseUrl: 'https://192.168.4.20:3001' } }));

type Pairing = typeof import('../services/PiPairingService');
type Device = typeof import('../services/enc/piChartDevice');
type Words = typeof import('../services/enc/piChartAccessWords');

let pairing: Pairing;
let device: Device;
let words: Words;

/** A fresh launch: module memory gone, Keychain and localStorage kept. */
async function launch(): Promise<void> {
    vi.resetModules();
    pairing = await import('../services/PiPairingService');
    device = await import('../services/enc/piChartDevice');
    words = await import('../services/enc/piChartAccessWords');
}

function makeSigner() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        spkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        sign: (body: string, path: string, time: string) =>
            nodeSign(
                'sha256',
                Buffer.from(['payload', createHash('sha256').update(body).digest('hex'), path, time].join('|')),
                { key: privateKey as KeyObject, dsaEncoding: 'ieee-p1363' },
            ).toString('base64'),
    };
}

const signer = makeSigner();

function pairKestrel(deviceId = PI_ID, spki = signer.spkiB64): void {
    pairing.savePairing({
        deviceId,
        boatName: 'Kestrel',
        publicKeySpki: spki,
        fingerprint: 'KE:ST:RE:L0',
        host: '192.168.4.20',
        pairedAt: '2026-10-10T09:00:00.000Z',
    });
}

interface Sent {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
}
type Reply = { status: number; data?: string; headers?: Record<string, string> };

/** The fake Pi: a route table, and a record of everything the app sent it. */
function pi(routes: (sent: Sent) => Reply | undefined): Sent[] {
    const sent: Sent[] = [];
    tls.request.mockImplementation(async (options: Sent) => {
        sent.push(options);
        const reply = routes(options) ?? { status: 404, data: '<pre>Cannot GET</pre>' };
        return { headers: {}, peerSpki: signer.spkiB64, data: '', ...reply };
    });
    return sent;
}

function signed(body: unknown, path: string): Reply {
    const text = JSON.stringify(body);
    const time = String(Date.now());
    return {
        status: 200,
        data: text,
        headers: { 'X-Pi-Signature': signer.sign(text, path, time), 'X-Pi-Signature-Time': time },
    };
}

const json = (status: number, body: unknown): Reply => ({ status, data: JSON.stringify(body) });
const path = (sent: Sent) => new URL(sent.url).pathname;
const headerOf = (sent: Sent) => sent.headers?.[HEADER];

/** The new Pi (update 3), as far as these tests need it. */
function newPi(extra: (sent: Sent) => Reply | undefined = () => undefined): Sent[] {
    return pi((sent) => {
        const hit = extra(sent);
        if (hit) return hit;
        const p = path(sent);
        if (p === '/api/enc/devices/enrol') return json(200, { deviceId: 'dev-iphone-1', token: TOKEN });
        if (p === '/api/enc/devices/status') {
            return json(
                200,
                headerOf(sent) === TOKEN
                    ? { enrolled: true, devices: 2, maxDevices: 5, cells: 1025, vault: 'ready' }
                    : { enrolled: false },
            );
        }
        if (p === '/api/enc/devices' && headerOf(sent) === TOKEN) {
            return json(200, {
                devices: [
                    { id: 'dev-iphone-1', label: 'iPhone', enrolledAt: '2026-10-10T09:05:00.000Z' },
                    {
                        id: 'dev-ipad-2',
                        label: 'iPad',
                        enrolledAt: '2026-10-10T09:20:00.000Z',
                        lastSeenAt: '2026-10-11T07:40:00.000Z',
                    },
                ],
                maxDevices: 5,
            });
        }
        if (p === '/api/enc/devices/code')
            return json(200, { code: 'HJKMN4PQRS', expiresAt: '2026-10-10T09:35:00.000Z' });
        if (p.startsWith('/api/enc/devices/') && sent.method === 'DELETE') return json(200, { removed: true });
        if (p === '/api/enc/health') return json(200, { status: 'ok' });
        if (p === '/api/enc/installed') return signed({ cells: [] }, p);
        return undefined;
    });
}

beforeEach(async () => {
    localStorage.clear();
    keychain.store.clear();
    keychain.native.value = true;
    vi.clearAllMocks();
    await launch();
    pairKestrel();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('enrolling this phone', () => {
    it('keeps the token in the Keychain under thalassa-pi-chart-device and nowhere else', async () => {
        const sent = newPi();
        await device.enrolChartDevice('hjkmn-4pqrs');

        const enrol = sent.find((s) => path(s) === '/api/enc/devices/enrol')!;
        expect(enrol.method).toBe('POST');
        expect(enrol.url).toBe(`${BASE}/api/enc/devices/enrol`);
        expect(enrol.data).toMatchObject({ code: 'HJKMN4PQRS' });
        expect(typeof (enrol.data as { label?: unknown }).label).toBe('string');

        expect(keychain.set).toHaveBeenCalledTimes(1);
        expect(keychain.set.mock.calls.every(([key]) => key === KEY)).toBe(true);
        expect(keychain.store.get(KEY)).toContain(TOKEN);
        expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
    });

    it('then sends it on /api/enc calls, and two of them after a relaunch make one Keychain read', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        await launch(); // the app is killed and opened again: memory gone, Keychain kept
        keychain.get.mockClear();
        const sent = newPi();

        await Promise.all([
            pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` }),
            pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` }),
        ]);
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });

        expect(keychain.get).toHaveBeenCalledTimes(1);
        expect(sent.map(headerOf)).toEqual([TOKEN, TOKEN, TOKEN]);
    });

    it('checks the code before asking the Pi, and accepts it with spaces, dashes and look-alikes', async () => {
        expect(device.normaliseChartCode(' hjkmn 4pqrs ')).toBe('HJKMN4PQRS');
        expect(device.normaliseChartCode('HJKMN-4PQRS')).toBe('HJKMN4PQRS');
        // Crockford base32: O reads as 0, I and L as 1, and U is never issued.
        expect(device.normaliseChartCode('oOiIl-LabcD')).toBe('001111ABCD');
        expect(device.normaliseChartCode('HJKMN4PQR')).toBeNull();
        expect(device.normaliseChartCode('HJKMN4PQRSU')).toBeNull();
        expect(device.normaliseChartCode('HJKMU4PQRS')).toBeNull();
        const sent = newPi();
        await expect(device.enrolChartDevice('HJK')).rejects.toThrow();
        expect(sent).toEqual([]);
    });

    it("refuses a token that is not the Pi's 43-character shape, and stores nothing", async () => {
        newPi((sent) =>
            path(sent) === '/api/enc/devices/enrol'
                ? json(200, { deviceId: 'dev-iphone-1', token: 'short' })
                : undefined,
        );
        await expect(device.enrolChartDevice('HJKMN4PQRS')).rejects.toThrow();
        expect(keychain.set).not.toHaveBeenCalled();
        expect(await pairing.getChartDevice()).toBeNull();
    });

    it('a sixth device hears it in plain words, with the boat named from the pairing', async () => {
        newPi((sent) =>
            path(sent) === '/api/enc/devices/enrol'
                ? json(409, { code: 'chart-device-limit', error: 'Five devices already enrolled' })
                : undefined,
        );
        const error = await device.enrolChartDevice('HJKMN4PQRS').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(pairing.PiHttpError);
        expect(error).toMatchObject({ status: 409, code: 'chart-device-limit' });
        expect(words.chartAccessWords('chart-device-limit', 'Kestrel').text).toBe(
            "Five phones and tablets already get Kestrel's charts. Remove one to add this one.",
        );
        expect(keychain.set).not.toHaveBeenCalled();
    });

    it('in the browser lane (no Keychain) keeps the token in memory only, never in localStorage', async () => {
        keychain.native.value = false;
        await launch();
        const sent = newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent.at(-1)!)).toBe(TOKEN);
        expect(keychain.set).not.toHaveBeenCalled();
        expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    });

    it('if the Keychain will not take it, keeps it for this launch and says so (the code is already spent)', async () => {
        // The Pi has enrolled this phone and used up the one-time code by the
        // time the token arrives. Dropping it then would leave a dead entry
        // on the Pi and no way to remove it from here.
        const warnings: unknown[] = [];
        vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
            warnings.push(...args);
        });
        keychain.set.mockRejectedValueOnce(new Error('Could not create secure storage'));
        newPi();
        await expect(device.enrolChartDevice('HJKMN4PQRS')).resolves.toBe(false);
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
        const sent = newPi();
        await device.removeChartDevice('dev-ipad-2'); // it can still manage the list this launch
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(sent.map(headerOf)).toEqual([TOKEN, TOKEN]);
        expect(words.chartAccessWords('chart-device-not-kept', 'Kestrel').quiet).toBe(false);
        expect(JSON.stringify(warnings.map(String))).not.toContain(TOKEN);
        expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    });

    it('when the Keychain takes it, says it was kept', async () => {
        newPi();
        await expect(device.enrolChartDevice('HJKMN4PQRS')).resolves.toBe(true);
    });
});

describe('when the token is dropped', () => {
    beforeEach(async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
    });

    it('Forget drops it from memory and the Keychain', async () => {
        pairing.forgetPairing();
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
        expect(keychain.store.has(KEY)).toBe(false);
        pairKestrel(); // paired again with the same Pi: still not sent
        const sent = newPi();
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent[0])).toBeUndefined();
    });

    it("a 'chart-device-removed' answer drops it, on the signed lane", async () => {
        newPi((sent) =>
            path(sent) === '/api/enc/installed' ? json(401, { code: 'chart-device-removed' }) : undefined,
        );
        const error = await pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` }).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 401, code: 'chart-device-removed' });
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
        const sent = newPi();
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent[0])).toBeUndefined();
    });

    it("a 'chart-device-removed' answer drops it, on the plain pinned lane", async () => {
        newPi((sent) => (path(sent) === '/api/enc/health' ? json(401, { code: 'chart-device-removed' }) : undefined));
        const res = await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(res.status).toBe(401);
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
        expect(await pairing.getChartDevice()).toBeNull();
    });

    it("a 'chart-device-not-enrolled' answer keeps it (the next enrol replaces it)", async () => {
        newPi((sent) =>
            path(sent) === '/api/enc/health' ? json(401, { code: 'chart-device-not-enrolled' }) : undefined,
        );
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(keychain.remove).not.toHaveBeenCalled();
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
    });

    it("a Pi presenting Kestrel's deviceId with a different key never gets it", async () => {
        // /api/pair/info hands the deviceId to anyone who asks, so it is not
        // proof of anything: the token is bound to the key that was pinned
        // when it was issued, and survives a reinstall only with that key.
        pairKestrel(PI_ID, makeSigner().spkiB64);
        const sent = newPi();
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent[0])).toBeUndefined();
        expect(await pairing.getChartDevice()).toBeNull();
        pairKestrel(); // the real Kestrel, same key as before: it goes again
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent[1])).toBe(TOKEN);
    });

    it('a pairing to a different Pi never sends it', async () => {
        const heron = makeSigner();
        pairKestrel('heron-pi-22c1', heron.spkiB64);
        const sent = newPi();
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        expect(headerOf(sent[0])).toBeUndefined();
        expect(await pairing.getChartDevice()).toBeNull();
    });

    it('removing this device drops it; removing another one keeps it', async () => {
        const sent = newPi();
        await device.removeChartDevice('dev-ipad-2');
        expect(sent.at(-1)).toMatchObject({ url: `${BASE}/api/enc/devices/dev-ipad-2`, method: 'DELETE' });
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
        await device.removeChartDevice('dev-iphone-1');
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
        expect(await pairing.getChartDevice()).toBeNull();
    });
});

describe('where the token goes', () => {
    it('never into a URL, a log line or localStorage', async () => {
        const consoleArgs: unknown[] = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                consoleArgs.push(...args);
            });
        }
        const stored: string[] = [];
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
            stored.push(`${k}=${v}`);
            return setItem.call(this, k, v);
        });

        const sent = newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        await device.loadChartAccess();
        await device.mintChartCode();
        await pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` });
        newPi((s) => (path(s) === '/api/enc/health' ? json(401, { code: 'chart-device-removed' }) : undefined));
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/health` });

        expect(sent.length).toBeGreaterThan(3);
        expect(sent.filter((s) => s.url.includes(TOKEN))).toEqual([]);
        expect(consoleArgs.filter((arg) => JSON.stringify(String(arg)).includes(TOKEN))).toEqual([]);
        expect(stored.filter((entry) => entry.includes(TOKEN))).toEqual([]);
        expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    });

    it('goes to /api/enc/* only: never /api/admin, /api/pair, a look-alike path or the pairing card', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        const sent = pi(() => json(200, {}));
        await pairing.pinnedPiRequest({ url: `${BASE}/api/admin/status` });
        await pairing.pinnedPiRequest({ url: `${BASE}/api/encore` });
        await pairing.pinnedPiRequest({ url: `${BASE}/api/osm/overlay?next=/api/enc/installed` });
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc` });
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/installed/ZZ5KESTR/data` });
        expect(sent.map(headerOf)).toEqual([undefined, undefined, undefined, TOKEN, TOKEN]);

        tls.pairingFetch.mockResolvedValue({ status: 404, data: '', headers: {}, peerSpki: '' });
        await pairing.fetchPairInfo(BASE);
        // The pairing card's transport takes a base URL and nothing else: it
        // cannot carry a header at all.
        expect(tls.pairingFetch.mock.calls).toEqual([[BASE]]);
    });
});

describe("today's Pi (update 2), before update 3 is installed", () => {
    /** No /api/enc/devices routes: Express's own 404 page, and the header ignored. */
    function oldPi(): Sent[] {
        return pi((sent) => {
            const p = path(sent);
            if (p === '/api/enc/installed') return signed({ cells: [{ cellId: 'ZZ5KESTR' }] }, p);
            if (p === '/api/enc/health') return json(200, { status: 'ok' });
            return { status: 404, data: `<!DOCTYPE html><pre>Cannot ${sent.method ?? 'GET'} ${p}</pre>` };
        });
    }

    it('reads as "needs its next update", quietly, never as an error', async () => {
        oldPi();
        expect(await device.loadChartAccess()).toEqual({ kind: 'said', code: 'pi-needs-update' });
        const said = words.chartAccessWords('pi-needs-update', 'Kestrel');
        expect(said.quiet).toBe(true);
        expect(said.text).toMatch(/Kestrel's Pi needs its next update/);
        expect(said.text).toMatch(/keep/);
        const error = await device.enrolChartDevice('HJKMN4PQRS').catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 404 });
        expect(device.chartCodeOf(error)).toBe('pi-needs-update');
    });

    it('keeps charts loading exactly as now: no token, no header, the same request', async () => {
        const sent = oldPi();
        await expect(pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` })).resolves.toEqual({
            cells: [{ cellId: 'ZZ5KESTR' }],
        });
        expect(sent[0]).toMatchObject({ url: `${BASE}/api/enc/installed`, method: 'GET', headers: undefined });
        expect(keychain.get).toHaveBeenCalledTimes(1); // one look, nothing there
    });

    it('keeps charts loading with a token from an earlier enrolment: the old Pi ignores the header', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        const sent = oldPi();
        await expect(pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` })).resolves.toEqual({
            cells: [{ cellId: 'ZZ5KESTR' }],
        });
        expect(headerOf(sent[0])).toBe(TOKEN);
        expect(await device.loadChartAccess()).toEqual({ kind: 'said', code: 'pi-needs-update' });
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
    });
});

describe('what the Pi says about this phone', () => {
    it("set up: the Pi's own numbers, the device list, and this one marked", async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        const access = await device.loadChartAccess();
        expect(access).toMatchObject({ kind: 'set-up', cells: 1025, max: 5 });
        if (access.kind !== 'set-up') throw new Error('expected set-up');
        expect(access.vault).toBeUndefined(); // 'ready' has nothing to say
        expect(access.devices).toEqual([
            { id: 'dev-iphone-1', label: 'iPhone', addedAt: '2026-10-10T09:05:00.000Z', self: true },
            {
                id: 'dev-ipad-2',
                label: 'iPad',
                addedAt: '2026-10-10T09:20:00.000Z',
                seenAt: '2026-10-11T07:40:00.000Z',
                self: false,
            },
        ]);
    });

    it("set up with the dongle out: the vault's state comes back as its words code", async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        newPi((s) =>
            path(s) === '/api/enc/devices/status'
                ? json(200, { enrolled: true, cells: 1025, vault: 'decoder-down' })
                : undefined,
        );
        expect(await device.loadChartAccess()).toMatchObject({ kind: 'set-up', vault: 'vault-decoder-down' });
        newPi((s) =>
            path(s) === '/api/enc/devices/status' ? json(200, { enrolled: true, vault: 'something-new' }) : undefined,
        );
        expect(await device.loadChartAccess()).toMatchObject({ kind: 'set-up', vault: undefined });
    });

    it('not set up: the code field, and no device list asked for', async () => {
        const sent = newPi();
        expect(await device.loadChartAccess()).toMatchObject({ kind: 'not-set-up' });
        expect(sent.map(path)).toEqual(['/api/enc/devices/status']);
    });

    it('removed elsewhere: the dead token is dropped and the phone can be set up again', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        newPi((s) =>
            path(s) === '/api/enc/devices/status' ? json(200, { enrolled: false, removed: true }) : undefined,
        );
        expect(await device.loadChartAccess()).toMatchObject({ kind: 'not-set-up', removed: true });
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
    });

    it('a status that refuses the token itself still shows the code field, whichever way the Pi orders its checks', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        newPi((s) => (path(s) === '/api/enc/devices/status' ? json(401, { code: 'chart-device-removed' }) : undefined));
        expect(await device.loadChartAccess()).toEqual({ kind: 'not-set-up', removed: true });
        await vi.waitFor(() => expect(keychain.remove).toHaveBeenCalledWith(KEY));
        newPi((s) =>
            path(s) === '/api/enc/devices/status' ? json(401, { code: 'chart-device-not-enrolled' }) : undefined,
        );
        expect(await device.loadChartAccess()).toEqual({ kind: 'not-set-up', removed: false });
    });

    it('a refusal comes back as its code: off the boat Wi-Fi, the dongle out', async () => {
        newPi((s) =>
            path(s) === '/api/enc/devices/status' ? json(403, { code: 'charts-boat-wifi-only' }) : undefined,
        );
        expect(await device.loadChartAccess()).toEqual({ kind: 'said', code: 'charts-boat-wifi-only' });
        newPi((s) => (path(s) === '/api/enc/devices/status' ? json(503, { code: 'vault-decoder-down' }) : undefined));
        expect(await device.loadChartAccess()).toEqual({ kind: 'said', code: 'vault-decoder-down' });
    });

    it('a Pi that cannot be reached is not an error wall either', async () => {
        tls.request.mockRejectedValue(new Error('The request timed out.'));
        // No code: the row says the Pi couldn't answer just now, never a status number.
        expect(await device.loadChartAccess()).toEqual({ kind: 'said', code: undefined });
    });

    it('a code for another phone or tablet', async () => {
        newPi();
        await device.enrolChartDevice('HJKMN4PQRS');
        await expect(device.mintChartCode()).resolves.toBe('HJKMN4PQRS');
    });
});
