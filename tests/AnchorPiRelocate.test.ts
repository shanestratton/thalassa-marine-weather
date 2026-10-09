/**
 * Moving the mark of a watch the PI keeps: AnchorPiWatchKeeper.relocate
 * (126-07a). The move is a re-POST of the assignment only, along the same
 * address ladder as begin and renew (the boat's LAN, then the tailnet). The
 * Pi's /api/anchor/watch replaces a watch in place, so no Pi change is needed.
 * No re-authorise, never end(), never begin().
 *
 * Three outcomes, and the phone must never claim more than it knows:
 *  - 2xx: the new assignment is current and persisted; the Pi's next report
 *    showing the new anchor confirms it.
 *  - an HTTP refusal: nothing changed; the old assignment stays current.
 *  - no answer at any address: UNKNOWN (the Pi may have applied it). While
 *    the Pi's own report may yet decide, renew() re-authorises only and
 *    re-asserts NEITHER point: re-POSTing the old one could silently undo a
 *    move the Pi did take. But not for ever: a Pi with no watch (rebooted, or
 *    its lease lapsed) never reports, so after two minutes with no report the
 *    renewal re-sends the MOVE's point.
 *
 * Real keeper and real handoff module; the Pi's transport, the Pi cache's
 * addresses, the cloud authorisation and the shore channel are stand-ins.
 * Fictional addresses and a fictional watch off Horta, the Azores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationPoint } from '../utils/navigationCalculations';
import type { PiTlsResponse } from '../services/piTls';
import type { PositionBroadcast, SyncBroadcast } from '../services/AnchorWatchSyncService';

const LAN = 'https://192.168.77.20:3001';
const TAILNET = 'https://100.71.8.9:3001';
const SESSION = 'AZORES0HORTA';

const pi = vi.hoisted(() => ({
    request: vi.fn(),
    ping: vi.fn(),
    status: { reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: 'relay-horta' } as Record<string, unknown>,
    base: 'https://192.168.77.20:3001' as string | null,
    remote: 'https://100.71.8.9:3001' as string | null,
}));
const sync = vi.hoisted(() => ({
    listeners: new Set<(data: unknown) => void>(),
    state: { sessionCode: 'AZORES0HORTA' as string | null, role: 'shore' },
    /** Shore Watch's latest report from the Pi, as the sync service holds it. */
    latest: null as unknown,
}));
const logged = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => pi.status,
        getBaseUrl: () => pi.base,
        getRemoteBaseUrl: () => pi.remote,
        ping: () => pi.ping(),
    },
}));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: (o: unknown) => pi.request(o) }));
vi.mock('../services/supabase', () => ({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fictional-jwt' } } }) } },
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onBroadcast: (listener: (data: unknown) => void) => {
            sync.listeners.add(listener);
            return () => sync.listeners.delete(listener);
        },
        getState: () => sync.state,
        getLatestPosition: () => sync.latest,
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logged.warn, error: vi.fn() }),
}));

import * as identityAtStart from '../services/authIdentityScope';

type Keeper = (typeof import('../services/anchorPiWatchKeeper'))['AnchorPiWatchKeeper'];

const HORTA = { latitude: 38.53, longitude: -28.62 };
const toward = (from: typeof HORTA, bearing: number, metres: number) => {
    const p = destinationPoint(from.latitude, from.longitude, bearing, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
};
/** She lies 30 m south-west of where the watch was set; the real anchor is 25 m out. */
const BOAT = toward(HORTA, 220, 30);
const NEW = toward(HORTA, 220, 25);
const ASSIGNMENT = {
    sessionCode: SESSION,
    anchorLat: HORTA.latitude,
    anchorLon: HORTA.longitude,
    swingRadius: 45,
    rodeLength: 40,
    waterDepth: 8,
};

const ok = (): PiTlsResponse => ({ status: 200, headers: {}, data: '{"status":"ok"}', peerSpki: '' });
const answer = (status: number, error: string): PiTlsResponse => ({
    status,
    headers: {},
    data: JSON.stringify({ status: 'error', error }),
    peerSpki: '',
});
const timedOut = () => new Error('The request timed out.');

const live = () => ({
    boatFix: { ...BOAT, timestamp: Date.now() - 3_000 },
    alarm: false,
    gpsLost: false,
});

function report(anchor: { latitude: number; longitude: number }): PositionBroadcast {
    return {
        type: 'position',
        vessel: { ...BOAT, accuracy: 0, heading: 0, speed: 0, timestamp: Date.now() },
        anchor: { ...anchor, timestamp: Date.now() },
        distance: 5,
        swingRadius: 45,
        isAlarm: false,
        config: { rodeLength: 40, waterDepth: 8 },
        timestamp: Date.now(),
    };
}

function hear(anchor: { latitude: number; longitude: number }) {
    const data = report(anchor);
    for (const listener of [...sync.listeners]) listener(data as SyncBroadcast);
}

/** The watch requests the keeper sent the Pi, in order. */
const posts = () =>
    pi.request.mock.calls
        .map(([o]) => o as { url: string; method?: string; data?: Record<string, number | string> })
        .filter((o) => o.method === 'POST');
const deletes = () =>
    pi.request.mock.calls.map(([o]) => o as { url: string; method?: string }).filter((o) => o.method === 'DELETE');

/**
 * The identity module the keeper sees. vi.resetModules() gives each fresh
 * keeper its own copy, so the account is set on that copy, not this file's.
 */
let identity: typeof identityAtStart = identityAtStart;
let user: string | null = 'skipper-horta';
function signIn(next: string | null) {
    user = next;
    identity.setAuthIdentityScope(next);
}

const stored = () => {
    const raw = localStorage.getItem(identity.authScopedStorageKey('thalassa_pi_watch_assignment'));
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

let keeper: Keeper;
const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

async function freshKeeper(): Promise<Keeper> {
    vi.resetModules();
    identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(user);
    return (await import('../services/anchorPiWatchKeeper')).AnchorPiWatchKeeper;
}

/** A Pi watch handed over off Horta, as Shore Watch's own phone holds it. */
async function keeping(): Promise<Keeper> {
    const k = await freshKeeper();
    pi.request.mockResolvedValue(ok());
    expect(await k.begin(ASSIGNMENT)).toBe(true);
    pi.request.mockReset();
    fetchMock.mockClear();
    logged.warn.mockClear();
    return k;
}

beforeEach(() => {
    localStorage.clear();
    identity = identityAtStart;
    signIn('skipper-horta');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://fictional-project.supabase.co');
    vi.stubGlobal('fetch', fetchMock);
    sync.listeners.clear();
    sync.state = { sessionCode: SESSION, role: 'shore' };
    sync.latest = null;
    pi.base = LAN;
    pi.remote = TAILNET;
    pi.status = { reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: 'relay-horta' };
    pi.request.mockReset();
    pi.ping.mockReset().mockResolvedValue({});
    fetchMock.mockClear();
});

afterEach(async () => {
    pi.request.mockResolvedValue(ok());
    await keeper?.end();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    signIn(null);
    identityAtStart.setAuthIdentityScope(null);
});

describe('a move the Pi takes (2xx at the boat LAN)', () => {
    it('makes the new point current and persists it, without begin, end or a re-authorise', async () => {
        keeper = await keeping();
        const begin = vi.spyOn(keeper, 'begin');
        const end = vi.spyOn(keeper, 'end');
        pi.request.mockResolvedValue(ok());

        const result = await keeper.relocate(NEW.latitude, NEW.longitude, live());

        expect(result).toEqual({ ok: true, ashore: false });
        expect(posts()).toHaveLength(1);
        expect(posts()[0].url).toBe(`${LAN}/api/anchor/watch`);
        expect(posts()[0].data).toEqual({ ...ASSIGNMENT, anchorLat: NEW.latitude, anchorLon: NEW.longitude });
        expect(deletes()).toHaveLength(0);
        expect(fetchMock).not.toHaveBeenCalled(); // no re-authorise mid-watch
        expect(begin).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(NEW.latitude);
        expect(keeper.getPending()).toMatchObject({ status: 'sent', target: NEW });
        // The first centre stays where the watch was set.
        expect(keeper.centreAtSet()).toEqual(HORTA);
        // From where the Pi watched (the boat, where the watch was set) to the new point.
        expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/^Pi anchor moved 25 m at 220°T \(aboard/));
    });

    it('renew() then re-asserts the NEW point', async () => {
        keeper = await keeping();
        pi.request.mockResolvedValue(ok());
        await keeper.relocate(NEW.latitude, NEW.longitude, live());
        pi.request.mockClear();

        expect(await keeper.renewNow()).toBe('assigned');

        expect(posts()).toHaveLength(1);
        expect(posts()[0].data).toMatchObject({ anchorLat: NEW.latitude, anchorLon: NEW.longitude });
    });

    it('is confirmed by the Pi’s own report of the new anchor', async () => {
        keeper = await keeping();
        pi.request.mockResolvedValue(ok());
        await keeper.relocate(NEW.latitude, NEW.longitude, live());
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));

        hear(HORTA); // a report from before the move: still sent, not confirmed
        expect(keeper.getPending()?.status).toBe('sent');
        hear(NEW);

        expect(keeper.getPending()?.status).toBe('confirmed');
        expect((stored()?.pending as { status: string }).status).toBe('confirmed');
        expect(sync.listeners.size).toBe(0);
    });
});

describe('a move the Pi refuses (HTTP 409)', () => {
    it('says the Pi is still watching the old point, and changes nothing', async () => {
        keeper = await keeping();
        pi.request.mockResolvedValueOnce(
            answer(409, 'This Pi is not paired to an account, so it cannot relay a watch'),
        );

        const result = await keeper.relocate(NEW.latitude, NEW.longitude, live());

        expect(result).toMatchObject({ ok: false, outcome: 'refused' });
        if (result.ok) throw new Error('moved');
        expect(result.error).toBe('The Pi is still watching the old point. Nothing was moved.');
        // A real answer is not a wrong address: the tailnet is not asked.
        expect(posts()).toHaveLength(1);
        expect(keeper.getPending()).toBeNull();
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(HORTA.latitude);
        expect(logged.warn).toHaveBeenCalledWith(expect.stringContaining('Pi anchor move refused (HTTP 409)'));
    });

    it('renew() re-asserts the OLD point', async () => {
        keeper = await keeping();
        pi.request.mockResolvedValueOnce(answer(409, 'not paired'));
        await keeper.relocate(NEW.latitude, NEW.longitude, live());
        pi.request.mockReset().mockResolvedValue(ok());

        await keeper.renewNow();

        expect(posts()[0].data).toMatchObject({ anchorLat: HORTA.latitude, anchorLon: HORTA.longitude });
    });
});

describe('the boat LAN does not answer and the tailnet does (ashore)', () => {
    it('moves it, remembers the address that answered, and says it was from ashore', async () => {
        keeper = await keeping();
        pi.request.mockRejectedValueOnce(timedOut()).mockResolvedValueOnce(ok());

        const result = await keeper.relocate(NEW.latitude, NEW.longitude, live());

        expect(result).toEqual({ ok: true, ashore: true });
        expect(posts().map((p) => p.url)).toEqual([`${LAN}/api/anchor/watch`, `${TAILNET}/api/anchor/watch`]);
        expect(keeper.answersFromAshore()).toBe(true);
        expect((stored()?.target as { baseUrl: string }).baseUrl).toBe(TAILNET);
        // Weighing anchor later goes to the address that answered.
        pi.request.mockReset().mockResolvedValue(ok());
        await keeper.end();
        expect(deletes().map((d) => d.url)).toEqual([`${TAILNET}/api/anchor/watch`]);
    });
});

describe('no answer at any address: the outcome is unknown', () => {
    async function unknownMove() {
        keeper = await keeping();
        pi.request.mockRejectedValue(timedOut());
        const result = await keeper.relocate(NEW.latitude, NEW.longitude, live());
        expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
        if (result.ok) throw new Error('moved');
        expect(result.error).toBe(
            'The Pi didn’t answer. It is watching either the old or the new point; Shore Watch will show which within a minute.',
        );
        expect(posts()).toHaveLength(2);
        pi.request.mockReset().mockResolvedValue(ok());
        fetchMock.mockClear();
        return result;
    }

    it('records the move as unknown, and persists it', async () => {
        await unknownMove();
        expect(keeper.getPending()).toMatchObject({ status: 'unknown', target: NEW, previous: HORTA });
        expect((stored()?.pending as { status: string }).status).toBe('unknown');
        // The current assignment is still the old one until the Pi says otherwise.
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(HORTA.latitude);
    });

    it('renew() within two minutes authorises but asserts neither point', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        await unknownMove();

        expect(await keeper.renewNow()).toBe('authorised');
        vi.setSystemTime(Date.now() + 119_000);
        expect(await keeper.renewNow()).toBe('authorised');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(posts()).toHaveLength(0);
    });

    it('with no report for over two minutes, the renewal re-sends the NEW point, once, and the next report confirms it', async () => {
        // The Pi rebooted or its lease lapsed: it holds no watch and reports
        // nothing, so waiting for its report would leave the boat unwatched.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        await unknownMove();
        vi.setSystemTime(Date.now() + 121_000);

        // The silence ladder's repair.
        expect(await keeper.renewNow()).toBe('assigned');

        expect(posts()).toHaveLength(1);
        expect(posts()[0].url).toBe(`${LAN}/api/anchor/watch`);
        expect(posts()[0].data).toEqual({ ...ASSIGNMENT, anchorLat: NEW.latitude, anchorLon: NEW.longitude });
        expect(keeper.getPending()).toMatchObject({ status: 'sent', target: NEW, previous: HORTA });
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(NEW.latitude);
        expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/unknown for 121 s .*re-sending the new point/));
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        hear(NEW);
        expect(keeper.getPending()?.status).toBe('confirmed');
        // From then on it is the watch, renewed like any other.
        pi.request.mockClear();
        expect(await keeper.renewNow()).toBe('assigned');
        expect(posts()).toHaveLength(1);
        expect(posts()[0].data).toMatchObject({ anchorLat: NEW.latitude, anchorLon: NEW.longitude });
    });

    it('past two minutes with the Pi still out of reach, each renewal tries the new point, and a report of the old one still settles it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        await unknownMove();
        vi.setSystemTime(Date.now() + 150_000);
        pi.request.mockReset().mockRejectedValue(timedOut());

        expect(await keeper.renewNow()).toBe('authorised');

        expect(posts().map((p) => p.data?.anchorLat)).toEqual([NEW.latitude, NEW.latitude]);
        expect(keeper.getPending()?.status).toBe('unknown');
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(HORTA.latitude);
        // The Pi was keeping the old point after all, and says so.
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        hear(HORTA);
        expect(keeper.getPending()).toBeNull();
        pi.request.mockReset().mockResolvedValue(ok());
        await keeper.renewNow();
        expect(posts()[0].data).toMatchObject({ anchorLat: HORTA.latitude, anchorLon: HORTA.longitude });
    });

    it('a report of the NEW anchor adopts it', async () => {
        await unknownMove();
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));

        hear(NEW);

        expect(keeper.getPending()?.status).toBe('confirmed');
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(NEW.latitude);
        await keeper.renewNow();
        expect(posts()[0].data).toMatchObject({ anchorLat: NEW.latitude, anchorLon: NEW.longitude });
    });

    it('a report of the OLD anchor, sent after the move could have landed, clears it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        await unknownMove();
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));

        // Heard straight after: it may have been on its way before the Pi took the move.
        hear(HORTA);
        expect(keeper.getPending()?.status).toBe('unknown');

        vi.setSystemTime(Date.now() + 16_000);
        hear(HORTA);

        expect(keeper.getPending()).toBeNull();
        expect(stored()?.pending ?? null).toBeNull();
        expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/kept the old point/i));
        await keeper.renewNow();
        expect(posts()[0].data).toMatchObject({ anchorLat: HORTA.latitude, anchorLon: HORTA.longitude });
    });

    it('a second move waits until the Pi’s report has settled the first', async () => {
        await unknownMove();
        const again = toward(HORTA, 220, 20);

        const result = await keeper.relocate(again.latitude, again.longitude, live());

        expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        if (result.ok) throw new Error('moved');
        expect(result.error).toMatch(/has not shown which point it is watching yet/);
        expect(posts()).toHaveLength(0);
        // Once its report shows the old point, a move can go again.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 16_000);
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        hear(HORTA);
        expect(await keeper.relocate(again.latitude, again.longitude, live())).toEqual({ ok: true, ashore: false });
    });

    it('survives a relaunch: restore() brings back the unknown move and still asserts neither point', async () => {
        await unknownMove();
        // The old process's listener, gone with it.
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        sync.listeners.clear();

        keeper = await freshKeeper();
        expect(keeper.restore()).toBe(true);

        expect(keeper.getPending()).toMatchObject({ status: 'unknown', target: NEW });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // restore's own renew
        expect(posts()).toHaveLength(0);
        // …and the Pi's next report still settles it.
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        hear(NEW);
        expect(keeper.getPending()?.status).toBe('confirmed');
    });

    it('after a relaunch more than two minutes on, with no report since, restore()’s renewal re-sends the new point', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        await unknownMove();
        await vi.waitFor(() => expect(sync.listeners.size).toBe(1));
        sync.listeners.clear();
        // The phone was off for a flight; the Pi's lease lapsed meanwhile.
        vi.setSystemTime(Date.now() + 6 * 3_600_000);

        keeper = await freshKeeper();
        expect(keeper.restore()).toBe(true);

        await vi.waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0].data).toMatchObject({ anchorLat: NEW.latitude, anchorLon: NEW.longitude });
        await vi.waitFor(() => expect(keeper.getPending()?.status).toBe('sent'));
        expect((stored()?.assignment as typeof ASSIGNMENT).anchorLat).toBe(NEW.latitude);
    });
});

describe('a move that waited behind a renewal', () => {
    /** A renewal on its way, its POST unanswered until `answer` is called. */
    async function renewalHanging(k: Keeper) {
        const answers: Array<(r: PiTlsResponse) => void> = [];
        pi.request.mockImplementation((o: { method?: string }) =>
            o.method === 'POST' ? new Promise<PiTlsResponse>((resolve) => answers.push(resolve)) : ok(),
        );
        const renewing = k.renewNow();
        await vi.waitFor(() => expect(posts()).toHaveLength(1));
        return { answers, renewing };
    }

    it('is judged with the newest report Shore Watch has heard, not the fix from the tap', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        keeper = await keeping();
        const { answers, renewing } = await renewalHanging(keeper);

        // Tapped with a fix 3 s old; the renewal ahead of it spends 40 s on
        // a boat-LAN address that no longer answers, while reports keep coming.
        const moving = keeper.relocate(NEW.latitude, NEW.longitude, live());
        vi.setSystemTime(Date.now() + 40_000);
        sync.latest = report(HORTA);
        answers[0](ok());
        await renewing;
        await vi.waitFor(() => expect(posts()).toHaveLength(2));
        answers[1](ok());

        expect(await moving).toEqual({ ok: true, ashore: false });
        expect(posts()[1].data).toMatchObject({ anchorLat: NEW.latitude, anchorLon: NEW.longitude });
    });

    it('is still refused when no report has come since the tap and the fix has aged past 30 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T03:00:00Z'));
        keeper = await keeping();
        const { answers, renewing } = await renewalHanging(keeper);

        const moving = keeper.relocate(NEW.latitude, NEW.longitude, live());
        vi.setSystemTime(Date.now() + 40_000);
        answers[0](ok());
        await renewing;
        const result = await moving;

        expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        if (result.ok) throw new Error('moved');
        expect(result.error).toMatch(/no recent position/);
        expect(posts()).toHaveLength(1);
    });

    it('a newer report that shows a drag alarm refuses it', async () => {
        keeper = await keeping();
        const { answers, renewing } = await renewalHanging(keeper);
        const moving = keeper.relocate(NEW.latitude, NEW.longitude, live());
        sync.latest = { ...report(HORTA), isAlarm: true };
        answers[0](ok());
        await renewing;
        const result = await Promise.race([
            moving,
            new Promise((resolve) => setTimeout(() => resolve('sent to the Pi'), 300)),
        ]);

        expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        expect(posts()).toHaveLength(1);
        answers[1]?.(ok());
    });

    it('a stale tap is refused at once, without waiting for the renewal', async () => {
        keeper = await keeping();
        const { answers, renewing } = await renewalHanging(keeper);

        const result = await Promise.race([
            keeper.relocate(NEW.latitude, NEW.longitude, {
                ...live(),
                boatFix: { ...BOAT, timestamp: Date.now() - 31_000 },
            }),
            new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
        ]);

        expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        answers[0](ok());
        await renewing;
    });
});

describe('whether this phone is ashore, for the sheet’s caution', () => {
    it('is aboard only while the boat’s LAN answers now', async () => {
        keeper = await keeping();
        const now = Date.now();
        pi.status = { reachable: true, lastCheck: now - 20_000, latencyMs: 4, diaryRelayId: 'relay-horta' };
        expect(keeper.answersFromAshore()).toBe(false);

        // Handed over aboard, then ashore: the LAN address still holds the
        // watch, but the health tick has not reached it for two minutes.
        pi.status = { ...pi.status, lastCheck: now - 120_000 };
        expect(keeper.answersFromAshore()).toBe(true);
        // The health ladder has moved to the tailnet.
        pi.status = { ...pi.status, lastCheck: now };
        pi.base = TAILNET;
        expect(keeper.answersFromAshore()).toBe(true);
        // Nothing answers at all.
        pi.base = LAN;
        pi.status = { ...pi.status, reachable: false };
        expect(keeper.answersFromAshore()).toBe(true);
        // A boat with no tailnet: the LAN answering is still aboard.
        pi.remote = null;
        pi.status = { ...pi.status, reachable: true, lastCheck: now };
        expect(keeper.answersFromAshore()).toBe(false);
    });

    it('is false with no Pi watch to move', async () => {
        keeper = await freshKeeper();
        expect(keeper.answersFromAshore()).toBe(false);
    });
});

describe('what it will not do', () => {
    it('refuses when this phone is not keeping a Pi watch', async () => {
        keeper = await freshKeeper();
        const result = await keeper.relocate(NEW.latitude, NEW.longitude, live());
        expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        expect(pi.request).not.toHaveBeenCalled();
    });

    it('sends nothing the guards refuse: the keeper judges again, whatever the sheet said', async () => {
        keeper = await keeping();
        for (const refused of [
            { ...live(), alarm: true },
            { ...live(), gpsLost: true },
            { ...live(), boatFix: { ...BOAT, timestamp: Date.now() - 31_000 } },
        ]) {
            const result = await keeper.relocate(NEW.latitude, NEW.longitude, refused);
            expect(result).toMatchObject({ ok: false, outcome: 'invalid' });
        }
        // 70 m from where it was set: past the 40 m rode's reach plus 15 m.
        const far = toward(HORTA, 220, 70);
        const boat = { ...toward(HORTA, 220, 60), timestamp: Date.now() };
        expect(
            await keeper.relocate(far.latitude, far.longitude, { boatFix: boat, alarm: false, gpsLost: false }),
        ).toMatchObject({ ok: false, outcome: 'invalid' });
        expect(pi.request).not.toHaveBeenCalled();
    });

    it('weighing anchor while a move is on its way wins: the Pi is told to stop again', async () => {
        keeper = await keeping();
        let answerPost: (r: PiTlsResponse) => void = () => undefined;
        pi.request.mockImplementation((o: { method?: string }) =>
            o.method === 'POST' ? new Promise<PiTlsResponse>((resolve) => (answerPost = resolve)) : ok(),
        );
        const moving = keeper.relocate(NEW.latitude, NEW.longitude, live());
        await vi.waitFor(() => expect(posts()).toHaveLength(1));

        await keeper.end();
        const stopsBeforeTheAnswer = deletes().length;
        answerPost(ok());
        const result = await moving;

        expect(result.ok).toBe(false);
        expect(keeper.isKeeping()).toBe(false);
        // A DELETE after the POST was answered: the Pi, which took the move
        // after end()'s DELETE, is not left watching a weighed anchor.
        expect(deletes()).toHaveLength(stopsBeforeTheAnswer + 1);
    });

    it('never lets an hourly renew land between a move and its answer', async () => {
        keeper = await keeping();
        const answers: Array<(r: PiTlsResponse) => void> = [];
        pi.request.mockImplementation((o: { method?: string }) =>
            o.method === 'POST' ? new Promise<PiTlsResponse>((resolve) => answers.push(resolve)) : ok(),
        );
        const renewing = keeper.renewNow();
        await vi.waitFor(() => expect(posts()).toHaveLength(1));
        const moving = keeper.relocate(NEW.latitude, NEW.longitude, live());
        await new Promise((r) => setTimeout(r, 20));
        // The move waits for the renewal's answer before it posts.
        expect(posts()).toHaveLength(1);
        answers[0](ok());
        await renewing;
        await vi.waitFor(() => expect(posts()).toHaveLength(2));
        answers[1](ok());
        expect(await moving).toEqual({ ok: true, ashore: false });
        expect(posts()[1].data).toMatchObject({ anchorLat: NEW.latitude });
    });
});

describe('identity', () => {
    it('account B never sees account A’s move, in memory or after a relaunch', async () => {
        keeper = await keeping();
        pi.request.mockRejectedValue(timedOut());
        await keeper.relocate(NEW.latitude, NEW.longitude, live());
        expect(keeper.getPending()?.status).toBe('unknown');

        signIn('skipper-lyttelton');
        expect(keeper.getPending()).toBeNull();

        keeper = await freshKeeper();
        expect(keeper.restore()).toBe(false);
        expect(keeper.getPending()).toBeNull();
    });
});
