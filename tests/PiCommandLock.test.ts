import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Only her own devices can command the Pi (129-12), the app's half.
 *
 * From Pi update 4 the boat's Pi answers a state-changing call only from a
 * phone or tablet it enrolled (the chart-device token, Pi update 3), once the
 * skipper turns that on; reads, the watch state and raising an alarm stay
 * open to everyone. So:
 *
 *   - the token rides EVERY Pi call made through pinnedPiRequest (not only
 *     /api/enc/*), never a URL, never the pairing card or the identity
 *     challenge, and only to the Pi that issued it; nothing else talks to the
 *     Pi but the pinned transport;
 *   - against each Pi generation: today's Pi (no lock at all) and an
 *     observing Pi behave exactly as now; an enforcing Pi's refusal comes back
 *     as words naming the boat ("This phone isn't set up for Kestrel's Pi.
 *     Type the code from her Pi."), and a 'removed' answer drops the token;
 *   - the Pi settings row reads the lock's state, hidden on a Pi that does not
 *     report it, and the switch says the Pi's own words when it refuses.
 *
 * Everything is fictional: Kestrel and Ψυχή, their Pis at 192.168.4.20.
 */

const KEY = 'thalassa-pi-chart-device';
const HEADER = 'X-Thalassa-Chart-Device';
const BASE = 'https://192.168.4.20:3001';
/** 43 base64url characters, unique so a scan can find it. */
const TOKEN = 'kestrelPiCommandToken_' + 'y'.repeat(21);
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
    return {
        ...real,
        usesNativeSecureStorage: () => true,
        getSecureValue: (key: string) => keychain.get(key),
        setSecureValue: (key: string, value: string) => keychain.set(key, value),
        removeSecureValue: (key: string) => keychain.remove(key),
    };
});
vi.mock('../services/PiCacheService', () => ({ piCache: { baseUrl: 'https://192.168.4.20:3001' } }));
vi.mock('../services/supabase', () => ({ supabase: null }));

type Pairing = typeof import('../services/PiPairingService');
type Refusal = typeof import('../services/piCommandRefusal');
type Lock = typeof import('../services/piCommandLock');
let pairing: Pairing;
let refusal: Refusal;
let lock: Lock;

async function launch(): Promise<void> {
    vi.resetModules();
    pairing = await import('../services/PiPairingService');
    refusal = await import('../services/piCommandRefusal');
    lock = await import('../services/piCommandLock');
}

function pairWith(boatName = 'Kestrel', deviceId = PI_ID, spki = 'kestrel-spki'): void {
    pairing.savePairing({
        deviceId,
        boatName,
        publicKeySpki: spki,
        fingerprint: 'KE:ST:RE:L0',
        host: '192.168.4.20',
        pairedAt: '2026-10-13T09:00:00.000Z',
    });
}

interface Sent {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    pinnedSpki?: string;
}
type Reply = { status: number; data?: string; headers?: Record<string, string> };
const json = (status: number, body: unknown): Reply => ({ status, data: JSON.stringify(body) });
const path_ = (sent: Sent) => new URL(sent.url).pathname;
const headerOf = (sent: Sent) => sent.headers?.[HEADER];

function pi(routes: (sent: Sent) => Reply | undefined): Sent[] {
    const sent: Sent[] = [];
    tls.request.mockImplementation(async (options: Sent) => {
        sent.push(options);
        const reply = routes(options) ?? { status: 404, data: '<pre>Cannot GET</pre>' };
        return { headers: {}, peerSpki: 'kestrel-spki', data: '', ...reply };
    });
    return sent;
}

const NOT_SET_UP = {
    status: 'error',
    code: 'pi-device-not-set-up',
    error: "This phone isn't set up for Kestrel's Pi. Type the code from her Pi.",
};

/** A Pi with the lock (Pi update 4). `mode` is the switch; the token is this phone's when it has one. */
function lockedPi(mode: 'observe' | 'enforce', enrolledToken: string | null = TOKEN): Sent[] {
    return pi((sent) => {
        const p = path_(sent);
        const mine = enrolledToken !== null && headerOf(sent) === enrolledToken;
        if (p === '/api/pi-lock' && (sent.method ?? 'GET') === 'GET') {
            return json(200, {
                v: 1,
                capability: 'pi-command-lock',
                mode,
                enforcing: mode === 'enforce',
                devices: 2,
                thisDevice: mine ? 'set-up' : 'not-set-up',
                unenrolled: [
                    { route: 'POST /api/ais-watch', calls: 3, lastAt: '2026-10-13T08:40:00.000Z' },
                    { route: 'POST /api/configure', calls: 1, lastAt: '2026-10-13T08:41:00.000Z' },
                    { route: 'POST /api/diary/entries', calls: 1, lastAt: '2026-10-13T08:42:00.000Z' },
                    { route: 'POST /api/seabed/config', calls: 1, lastAt: '2026-10-13T08:43:00.000Z' },
                ],
                since: '2026-10-13T06:00:00.000Z',
            });
        }
        const reads = (sent.method ?? 'GET') === 'GET' || p === '/api/ais-watch/ack';
        if (!reads && mode === 'enforce' && !mine) return json(403, NOT_SET_UP);
        return json(200, { status: 'ok' });
    });
}

beforeEach(async () => {
    localStorage.clear();
    keychain.store.clear();
    vi.clearAllMocks();
    await launch();
    pairWith();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function enrolThisPhone(): Promise<void> {
    await pairing.saveChartDevice({ chartDeviceId: 'dev-iphone-1', token: TOKEN });
}

describe('the token rides every Pi call, through pinnedPiRequest only', () => {
    it('on every pinned call, reads and commands alike, and on the signed lane', async () => {
        await enrolThisPhone();
        const sent = pi((s) => (path_(s) === '/api/enc/installed' ? undefined : json(200, { status: 'ok' })));
        for (const [url, method] of [
            [`${BASE}/api/admin/status`, 'GET'],
            [`${BASE}/api/telemetry`, 'GET'],
            [`${BASE}/api/ais-watch`, 'POST'],
            [`${BASE}/api/ais-watch/ack`, 'POST'],
            [`${BASE}/api/anchor/watch`, 'DELETE'],
            [`${BASE}/api/configure`, 'POST'],
            [`${BASE}/cache/purge`, 'POST'],
            [`${BASE}/api/remote-access/enable`, 'POST'],
            [`${BASE}/api/pi-lock`, 'GET'],
            [`${BASE}/api/enc/devices`, 'GET'],
            [`https://100.64.0.7:3001/api/diary/entries`, 'POST'],
        ] as const) {
            await pairing.pinnedPiRequest({ url, method });
        }
        await pairing.fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` }).catch(() => undefined);
        expect(sent).toHaveLength(12);
        expect(sent.map(headerOf)).toEqual(Array(12).fill(TOKEN));
        // Pinned to the paired Pi's key, every one.
        expect(sent.every((s) => s.pinnedSpki === 'kestrel-spki')).toBe(true);
        expect(sent.filter((s) => s.url.includes(TOKEN))).toEqual([]);
    });

    it('never on the pairing card or the identity challenge, and never to another Pi', async () => {
        await enrolThisPhone();
        const sent = pi(() => json(200, {}));
        tls.pairingFetch.mockResolvedValue({ status: 404, data: '', headers: {}, peerSpki: '' });
        await pairing.fetchPairInfo(BASE);
        expect(tls.pairingFetch.mock.calls).toEqual([[BASE]]);
        await pairing.verifyPairedPi(BASE, pairing.getPairing()!);
        expect(sent.map(path_)).toEqual(['/api/pair/challenge']);
        expect(headerOf(sent[0])).toBeUndefined();
        // Paired to a different Pi (another deviceId, another key): its calls carry nothing.
        pairWith('Ψυχή', 'psyche-pi-01', 'psyche-spki');
        await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST' });
        expect(headerOf(sent[1])).toBeUndefined();
    });

    it('with no token yet, the call is exactly as it was', async () => {
        const sent = pi(() => json(200, { status: 'ok' }));
        await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST', data: { a: 1 } });
        expect(sent[0]).toMatchObject({ url: `${BASE}/api/configure`, method: 'POST', headers: undefined });
    });

    it('nothing else talks to the Pi: no raw transport outside the pinned door', () => {
        const allowed = new Map([
            ['services/piTls.ts', 'IS the transport'],
            ['services/PiPairingService.ts', 'owns pinnedPiRequest, fetchVerifiedFromPi and the identity challenge'],
            [
                'services/PiCacheService.ts',
                'the discovery probe: a read (/health, or the pairing card before a Pi is paired) raced across candidate hosts',
            ],
        ]);
        const walk = (dir: string, out: string[] = []): string[] => {
            for (const entry of fs.readdirSync(dir)) {
                if (entry === 'node_modules' || entry.startsWith('.')) continue;
                const full = path.join(dir, entry);
                if (fs.statSync(full).isDirectory()) walk(full, out);
                else if (/\.tsx?$/.test(entry)) out.push(full.split(path.sep).join('/'));
            }
            return out;
        };
        const offenders: string[] = [];
        for (const file of ['services', 'components', 'hooks', 'stores', 'utils'].flatMap((d) => walk(d))) {
            if (allowed.has(file)) continue;
            const code = fs
                .readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            if (/(?<![A-Za-z0-9_$])piRequest\s*\(|PiTls\.request\s*\(/.test(code)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
        // The probe is the one call there, and it carries no token: it is a read of /health or the card.
        const cache = fs.readFileSync('services/PiCacheService.ts', 'utf8');
        expect(cache.match(/(?<![A-Za-z0-9_$])piRequest\s*\(/g)).toHaveLength(1);
        expect(cache).toMatch(/const url = pinnedSpki \? `\$\{base\}\/health` : `\$\{base\}\/api\/pair\/info`;/);
        // The two that used to go round it now go through it.
        for (const file of ['services/piTrackRecorder.ts', 'services/seabed/SeabedSettingsService.ts']) {
            expect(fs.readFileSync(file, 'utf8')).toMatch(/pinnedPiRequest\(/);
        }
    });
});

describe('each Pi generation', () => {
    it("today's Pi (no lock): no row, and every command answers exactly as now", async () => {
        await enrolThisPhone();
        const sent = pi((s) =>
            path_(s) === '/api/pi-lock'
                ? { status: 404, data: '<pre>Cannot GET /api/pi-lock</pre>' }
                : json(200, { status: 'ok' }),
        );
        expect(await lock.loadPiLock()).toBeNull();
        const res = await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST' });
        expect(res.status).toBe(200);
        expect(refusal.piCommandRefusalWords()).toBeNull();
        // The old Pi ignores the header it has never heard of.
        expect(headerOf(sent[1])).toBe(TOKEN);
    });

    it('a Pi that cannot be asked shows no row either (never a broken one)', async () => {
        tls.request.mockRejectedValue(new Error('The network connection was lost.'));
        expect(await lock.loadPiLock()).toBeNull();
    });

    it('an observing Pi: the row says so, and nothing changes for a phone not set up', async () => {
        lockedPi('observe', null);
        expect(await lock.loadPiLock()).toEqual({
            mode: 'observe',
            enforcing: false,
            devices: 2,
            thisDevice: 'not-set-up',
            seen: [
                { words: 'stand the night watch down', calls: 3 },
                { words: 'change her settings', calls: 1 },
                { words: 'post to the diary', calls: 1 },
                { words: 'other changes', calls: 1 },
            ],
        });
        expect((await pairing.pinnedPiRequest({ url: `${BASE}/api/anchor/watch`, method: 'DELETE' })).status).toBe(200);
        expect(refusal.piCommandRefusalWords()).toBeNull();
    });

    it('an enforcing Pi: a refused command comes back with its code and words naming the boat; raising an alarm still goes', async () => {
        lockedPi('enforce', TOKEN); // this phone has no token, so it is not the enrolled one
        const res = await pairing.pinnedPiRequest({ url: `${BASE}/api/anchor/watch`, method: 'DELETE' });
        expect(res.status).toBe(403);
        expect(refusal.piCommandRefusalCode(res)).toBe('pi-device-not-set-up');
        expect(JSON.parse(res.data).error).toBe(refusal.piRefusalWords('pi-device-not-set-up', 'Kestrel'));
        const ack = await pairing.pinnedPiRequest({ url: `${BASE}/api/ais-watch/ack`, method: 'POST' });
        expect(ack.status).toBe(200);
        // The row reads it, and says this phone is not set up.
        expect(await lock.loadPiLock()).toMatchObject({ mode: 'enforce', enforcing: true, thisDevice: 'not-set-up' });
    });

    it('a refused call this phone made in the background (the Pi settings push) paints nothing: only its own commands do', async () => {
        lockedPi('enforce', null);
        expect((await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST' })).status).toBe(403);
        expect(refusal.piCommandRefusalWords()).toBeNull();
        // Its own stop of the anchor watch it handed over: said, naming the boat.
        const handoff = await import('../services/anchorPiHandoff');
        expect(await handoff.clearWatchOnPi(BASE)).toBe(true);
        expect(refusal.piCommandRefusalWords()).toBe(
            "This phone isn't set up for Kestrel's Pi. Type the code from her Pi.",
        );
    });

    it('the words name her, whatever her name: never a hard-coded boat', async () => {
        pairWith('Ψυχή', 'psyche-pi-01', 'psyche-spki');
        pi(() =>
            json(403, { ...NOT_SET_UP, error: "This phone isn't set up for Ψυχή's Pi. Type the code from her Pi." }),
        );
        const handoff = await import('../services/anchorPiHandoff');
        await handoff.clearWatchOnPi(BASE);
        expect(refusal.piCommandRefusalWords()).toBe(
            "This phone isn't set up for Ψυχή's Pi. Type the code from her Pi.",
        );
        expect(refusal.piRefusalWords('pi-device-not-set-up', 'Tūī')).toBe(
            "This phone isn't set up for Tūī's Pi. Type the code from her Pi.",
        );
        expect(refusal.piRefusalWords('pi-device-not-set-up', '')).toBe(
            "This phone isn't set up for your boat's Pi. Type the code from her Pi.",
        );
    });

    it('setting this phone up clears the words; a new pairing clears them too', async () => {
        const handoff = await import('../services/anchorPiHandoff');
        lockedPi('enforce');
        expect(await handoff.clearWatchOnPi(BASE)).toBe(true);
        expect(refusal.piCommandRefusalWords()).not.toBeNull();
        await enrolThisPhone();
        expect(refusal.piCommandRefusalWords()).toBeNull();
        expect(await handoff.clearWatchOnPi(BASE)).toBe(false);
        expect(refusal.piCommandRefusalWords()).toBeNull();
        pi(() => json(403, NOT_SET_UP));
        await handoff.clearWatchOnPi(BASE);
        expect(refusal.piCommandRefusalWords()).not.toBeNull();
        pairWith('Ψυχή', 'psyche-pi-01', 'psyche-spki');
        expect(refusal.piCommandRefusalWords()).toBeNull();
    });

    it('the words go by themselves after 15 minutes without another refusal', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-13T09:00:00Z'));
        lockedPi('enforce', null);
        const handoff = await import('../services/anchorPiHandoff');
        await handoff.clearWatchOnPi(BASE);
        vi.setSystemTime(Date.parse('2026-10-13T09:14:00Z'));
        expect(refusal.piCommandRefusalWords()).not.toBeNull();
        vi.setSystemTime(Date.parse('2026-10-13T09:15:30Z'));
        expect(refusal.piCommandRefusalWords()).toBeNull();
    });

    it("'removed' from her Pi: the dead token is dropped, on any route, and the words say so", async () => {
        await enrolThisPhone();
        const sent = pi(() =>
            json(403, {
                status: 'error',
                code: 'pi-device-removed',
                error: "This phone was removed from Kestrel's Pi. Type a new code from her Pi.",
            }),
        );
        // A background call: the dead token goes, though nothing is said.
        await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST' });
        await vi.waitFor(() => expect(keychain.store.has(KEY)).toBe(false));
        expect(refusal.piCommandRefusalWords()).toBeNull();
        await pairing.pinnedPiRequest({ url: `${BASE}/api/configure`, method: 'POST' });
        expect(headerOf(sent[0])).toBe(TOKEN);
        expect(headerOf(sent[1])).toBeUndefined();
        expect(await pairing.getChartDevice()).toBeNull();
        // This phone's own stop: the words say it was removed.
        const handoff = await import('../services/anchorPiHandoff');
        await handoff.clearWatchOnPi(BASE);
        expect(refusal.piCommandRefusalWords()).toBe(
            "This phone was removed from Kestrel's Pi. Type a new code from her Pi.",
        );
    });

    it("a refusal that is not the lock's is left alone", async () => {
        await enrolThisPhone();
        pi(() => json(403, { code: 'charts-boat-wifi-only' }));
        await pairing.pinnedPiRequest({ url: `${BASE}/api/enc/installed` });
        pi(() => json(400, { status: 'error', error: 'sessionCode must be 12 alphanumeric characters' }));
        await pairing.pinnedPiRequest({ url: `${BASE}/api/anchor/watch`, method: 'POST' });
        expect(refusal.piCommandRefusalWords()).toBeNull();
        expect(await pairing.getChartDevice()).toEqual({ chartDeviceId: 'dev-iphone-1' });
    });
});

describe('the anchor watch hand-off says it too', () => {
    it("a refused stop is reported, a refused move carries the Pi's words, and a Pi that takes it is not", async () => {
        lockedPi('enforce', null);
        const handoff = await import('../services/anchorPiHandoff');
        expect(await handoff.clearWatchOnPi(BASE)).toBe(true);
        expect(refusal.piCommandRefusalWords()).toBe(
            "This phone isn't set up for Kestrel's Pi. Type the code from her Pi.",
        );
        const moved = await handoff.sendAssignmentToPi(
            { sessionCode: 'KESTREL12345', anchorLat: 50.76, anchorLon: -1.29, swingRadius: 40 },
            BASE,
        );
        expect(moved).toEqual({ taken: false, status: 403, error: NOT_SET_UP.error, notSetUp: true });
        pi(() => json(200, { status: 'ok' }));
        expect(await handoff.clearWatchOnPi(BASE)).toBe(false);
        pi(() =>
            json(409, { status: 'error', error: 'This Pi is not paired to an account, so it cannot relay a watch' }),
        );
        expect(
            await handoff.sendAssignmentToPi(
                { sessionCode: 'KESTREL12345', anchorLat: 50.76, anchorLon: -1.29, swingRadius: 40 },
                BASE,
            ),
        ).not.toHaveProperty('notSetUp');
        tls.request.mockRejectedValue(new Error('offline'));
        expect(await handoff.clearWatchOnPi(BASE)).toBe(false);
    });
});

describe('the boat track recorder says it too', () => {
    it("a refused switch is noted in her Pi's words (the card says them); its reads never are", async () => {
        lockedPi('enforce', null);
        const track = await import('../services/piTrackRecorder');
        expect(await track.getPiTrackStatus()).not.toBeNull();
        expect(refusal.piCommandRefusalWords()).toBeNull();
        expect(await track.setPiTrackRecording(true)).toBeNull();
        expect(refusal.piCommandRefusalWords()).toBe(
            "This phone isn't set up for Kestrel's Pi. Type the code from her Pi.",
        );
        // Only one noted since a moment: an older refusal is never blamed for a later failure.
        const later = Date.now() + 1;
        expect(refusal.piCommandRefusalWords(later, later)).toBeNull();
    });
});

describe('the switch', () => {
    it('turns on from a phone set up for her, and says what the Pi now does', async () => {
        await enrolThisPhone();
        let mode: 'observe' | 'enforce' = 'observe';
        const sent = pi((s) => {
            if (path_(s) !== '/api/pi-lock') return undefined;
            if (s.method === 'POST') mode = (s.data as { mode: 'observe' | 'enforce' }).mode;
            return json(200, {
                v: 1,
                capability: 'pi-command-lock',
                mode,
                enforcing: mode === 'enforce',
                devices: 1,
                thisDevice: headerOf(s) === TOKEN ? 'set-up' : 'not-set-up',
                unenrolled: [],
                since: '2026-10-13T06:00:00.000Z',
            });
        });
        expect(await lock.setPiLockMode('enforce')).toMatchObject({
            mode: 'enforce',
            enforcing: true,
            thisDevice: 'set-up',
        });
        expect(sent[0]).toMatchObject({ method: 'POST', data: { mode: 'enforce' }, headers: { [HEADER]: TOKEN } });
    });

    it("a refused switch says the Pi's own words: no device set up, her own Wi-Fi only, this phone not set up", async () => {
        for (const said of [
            {
                status: 409,
                code: 'pi-lock-no-devices',
                error: "Set up a phone or tablet for Kestrel's Pi first. With none set up, nobody could change her Pi.",
            },
            { status: 403, code: 'pi-lock-boat-wifi-only', error: "Change this on Kestrel's own Wi-Fi." },
            { status: 403, code: NOT_SET_UP.code, error: NOT_SET_UP.error },
        ]) {
            pi(() => json(said.status, { status: 'error', code: said.code, error: said.error }));
            expect(await lock.setPiLockMode('enforce')).toEqual({ said: said.error });
        }
        pi(() => ({ status: 500, data: '<html>' }));
        expect(await lock.setPiLockMode('observe')).toEqual({
            said: "Kestrel's Pi couldn't change that just now. Try again in a minute.",
        });
        tls.request.mockRejectedValue(new Error('offline'));
        expect(await lock.setPiLockMode('observe')).toEqual({
            said: "Kestrel's Pi couldn't change that just now. Try again in a minute.",
        });
    });
});
