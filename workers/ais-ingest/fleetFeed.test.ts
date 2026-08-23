/**
 * The punter crowd-feed endpoint, exercised through a real http server with
 * injected auth/quota/UDP seams. The posture under test: cheap rejections
 * first, no unauthenticated byte reaches the decoder, every accepted
 * sentence lands in the pond AND on the AISHub wire.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetFleetFeedForTest, handleFleetFeed, type FleetFeedDeps, type UserClientLike } from './fleetFeed.js';
import { __resetFragmentsForTest } from './aivdm.js';
import type { VesselDB } from './db.js';

const T1 = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';
const T18_AIVDO = '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F';

function makeDeps(over: Partial<FleetFeedDeps> = {}) {
    const enqueued: unknown[] = [];
    const sent: string[] = [];
    const client: UserClientLike = {
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        rpc: vi.fn(async () => ({ data: true, error: null })),
    };
    const deps: FleetFeedDeps = {
        db: { enqueue: (r: unknown) => enqueued.push(r) } as unknown as VesselDB,
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon',
        createUserClient: () => client,
        udpSend: (line) => sent.push(line),
        ...over,
    };
    return { deps, enqueued, sent, client };
}

let server: http.Server;
let base: string;
let currentDeps: FleetFeedDeps;

beforeEach(async () => {
    __resetFleetFeedForTest();
    __resetFragmentsForTest();
    server = http.createServer((req, res) => void handleFleetFeed(req, res, currentDeps));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    await new Promise((r) => server.close(r));
});

const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/`, { method: 'POST', headers: { Authorization: 'Bearer token-abc', ...headers }, body });

describe('fleet-feed gate order', () => {
    it('rejects non-POST with 405', async () => {
        const { deps } = makeDeps();
        currentDeps = deps;
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(405);
    });

    it('rejects a missing or malformed bearer before reading a byte', async () => {
        const { deps, client } = makeDeps();
        currentDeps = deps;
        const res = await fetch(`${base}/`, { method: 'POST', body: T1 });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect(client.auth.getUser).not.toHaveBeenCalled();
    });

    it('rejects an invalid token with 401', async () => {
        const { deps, client } = makeDeps();
        (client.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { user: null },
            error: { message: 'bad' },
        });
        currentDeps = deps;
        const res = await post(T1);
        expect(res.status).toBe(401);
    });

    it('rations per user via consume_edge_quota on the USER client', async () => {
        const { deps, client } = makeDeps();
        (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: false, error: null });
        currentDeps = deps;
        const res = await post(T1);
        expect(res.status).toBe(429);
        expect(client.rpc).toHaveBeenCalledWith('consume_edge_quota', expect.objectContaining({ p_bucket: 'fleet-feed' }));
    });
});

describe('fleet-feed acceptance', () => {
    it('decodes valid sentences into the pond and forwards raw to AISHub', async () => {
        const { deps, enqueued, sent } = makeDeps();
        currentDeps = deps;
        const res = await post(`${T1}\n${T18_AIVDO}\n`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            accepted: 2,
            decoded: 2,
            rejected: { tooLong: 0, notAis: 0, checksum: 0 },
        });
        expect(enqueued).toHaveLength(2);
        // AIVDM forwarded as-is; own-ship AIVDO rewritten as a receipt.
        expect(sent[0]).toBe(T1);
        expect(sent[1].startsWith('!AIVDM,')).toBe(true);
    });

    // Renamed 2026-08-23: it no longer drops them SILENTLY, which was the
    // whole problem. Every rejection here used to be a bare `continue`, so a
    // multiplexer mangling every fragment produced byte-for-byte the same 200
    // as a perfect gateway — and the skipper got a green "sharing live" card
    // either way. The reason now rides back in the response so the app can say
    // which fault it is instead of just that something is wrong.
    it('drops garbage, wrong talkers and bad checksums, and reports why', async () => {
        const { deps, enqueued, sent } = makeDeps();
        currentDeps = deps;
        const res = await post(['$GPGGA,junk*00', 'not a sentence', T1.replace('17Ojo', '17Ojp'), T1].join('\n'));
        expect(await res.json()).toEqual({
            accepted: 1,
            decoded: 1,
            // Two wrong talkers, one mangled checksum — told apart, because
            // they mean completely different things on a boat.
            rejected: { tooLong: 0, notAis: 2, checksum: 1 },
        });
        expect(enqueued).toHaveLength(1);
        expect(sent).toHaveLength(1);
    });

    it('refuses oversized batches with 413', async () => {
        const { deps } = makeDeps();
        currentDeps = deps;
        const res = await post('x'.repeat(200 * 1024));
        expect(res.status).toBe(413);
    });

    it('caches the verified token so GoTrue is not hit per batch', async () => {
        const { deps, client } = makeDeps();
        currentDeps = deps;
        await post(T1);
        await post(T1);
        expect(client.auth.getUser).toHaveBeenCalledTimes(1);
        // …but the quota RPC runs on EVERY batch — the ration is not cached.
        expect(client.rpc).toHaveBeenCalledTimes(2);
    });
});

describe('injection hardening (review 2026-08-21)', () => {
    it('refuses a sentence with bytes smuggled after the checksum', async () => {
        const { deps, sent, enqueued } = makeDeps();
        currentDeps = deps;
        // Valid checksum for the AIVDM body, then a CR and a fake sentence —
        // the exact AISHub-injection vector.
        const injected = '!AIVDM,1,1,,A,15M,0*6F\r$GPGGA,INJECTED,TO,AISHUB';
        const res = await post(injected);
        expect(await res.json()).toEqual({
            accepted: 0,
            decoded: 0,
            // Counted as a checksum failure: it opens with a valid talker, so
            // the strict checksum gate is what actually stops it.
            rejected: { tooLong: 0, notAis: 0, checksum: 1 },
        });
        expect(sent).toHaveLength(0);
        expect(enqueued).toHaveLength(0);
    });

    it('the AIVDM forward is rebuilt, never verbatim', async () => {
        const { deps, sent } = makeDeps();
        currentDeps = deps;
        await post(T1);
        // A rebuilt sentence has no trailing fragment and a fresh uppercase
        // checksum; it round-trips the same payload.
        expect(sent[0].split(',')[5]).toBe(T1.split(',')[5]);
        expect(sent[0]).toMatch(/\*[0-9A-F]{2}$/);
    });

    it('negative-caches a bad token so a spray does not hammer GoTrue', async () => {
        const { deps, client } = makeDeps();
        (client.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { user: null },
            error: { message: 'bad' },
        });
        currentDeps = deps;
        await post(T1, { Authorization: 'Bearer spray-1' });
        await post(T1, { Authorization: 'Bearer spray-1' });
        // Second identical bad token served from the negative cache — one hop.
        expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    });
});

/**
 * The watch check-in — the mechanism the whole reciprocity design rests on.
 *
 * Before this existed, AisShareService returned early on `buffer.length < 5`
 * before it ever touched the network, so a receive-only rig with no ships in
 * range made ZERO requests, forever. The empty-bay punter — the most valuable
 * contributor in the fleet, and the only ear for hundreds of miles — was
 * byte-for-byte indistinguishable from someone who flipped the toggle on and
 * unplugged the aerial.
 */
describe('watch check-in', () => {
    /** Route consume_edge_quota to `true` and capture record_ais_watch. */
    function watchDeps(watchResult: { data: unknown; error: unknown | null } = { data: { ok: true, standing: 'on_watch' }, error: null }) {
        const calls: { name: string; args: Record<string, unknown> }[] = [];
        const base = makeDeps();
        const client: UserClientLike = {
            auth: base.deps.createUserClient
                ? { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) }
                : ({} as never),
            rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
                calls.push({ name, args });
                if (name === 'consume_edge_quota') return { data: true, error: null };
                return watchResult;
            }),
        };
        const deps: FleetFeedDeps = { ...base.deps, createUserClient: () => client };
        return { deps, calls, enqueued: base.enqueued, sent: base.sent };
    }

    const WATCH = {
        'X-Thalassa-Watch': '1',
        'X-Thalassa-Connected': '300',
        'X-Thalassa-Link': 'connected',
        'X-Thalassa-Rig': 'receive-only',
    };

    it('credits an EMPTY batch from a boat that heard nothing', async () => {
        // Osprey Reef: receiver working, no ships for 200 miles, nothing to
        // send. This must be a full, ordinary, credited check-in.
        const { deps, calls } = watchDeps();
        currentDeps = deps;
        const res = await post('', WATCH);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.accepted).toBe(0);
        expect(body.decoded).toBe(0);

        const credit = calls.find((c) => c.name === 'record_ais_watch');
        expect(credit).toBeDefined();
        expect(credit?.args.p_connected_s).toBe(300);
        expect(credit?.args.p_heard).toBe(false);
        // ...and the response carries the standing back, so the card survives
        // an app relaunch rather than resetting to zero like today's stats.
        expect(body.watch).toEqual({ ok: true, standing: 'on_watch' });
    });

    it('credits identical connected seconds regardless of yield', async () => {
        // Constraint 1 at the wire: the busy harbour and the empty ocean send
        // the same claim and must be charged the same way. p_sentences rides
        // along for diagnostics and lands in a column no rule reads.
        const quiet = watchDeps();
        currentDeps = quiet.deps;
        await post('', WATCH);

        const busy = watchDeps();
        currentDeps = busy.deps;
        await post(T1, { ...WATCH, 'X-Thalassa-Heard': '4821' });

        const a = quiet.calls.find((c) => c.name === 'record_ais_watch')?.args;
        const b = busy.calls.find((c) => c.name === 'record_ais_watch')?.args;
        expect(a?.p_connected_s).toBe(b?.p_connected_s);
        expect(b?.p_sentences).toBe(4821);
        expect(a?.p_sentences).toBe(0);
    });

    it('records a check-in whose gateway is DOWN', async () => {
        // The fault the ledger most needs to hear about must not be the fault
        // that silences the report. Zero connected seconds, still recorded,
        // with the error carried so the card can name it.
        const { deps, calls } = watchDeps();
        currentDeps = deps;
        const res = await post('', {
            'X-Thalassa-Watch': '1',
            'X-Thalassa-Connected': '0',
            'X-Thalassa-Link': 'down',
            'X-Thalassa-Link-Err': 'ECONNREFUSED 192.168.1.50:2000',
            'X-Thalassa-Reconnects': '41',
        });
        expect(res.status).toBe(200);
        const credit = calls.find((c) => c.name === 'record_ais_watch')?.args;
        expect(credit?.p_link).toBe('down');
        expect(credit?.p_connected_s).toBe(0);
        expect(credit?.p_link_error).toBe('ECONNREFUSED 192.168.1.50:2000');
        expect(credit?.p_reconnects).toBe(41);
    });

    it('never lets a ledger failure cost a skipper their sentences', async () => {
        // Invariant 4. The sentences are banked before crediting is attempted,
        // so a ledger outage degrades to "no credit this batch", never to a
        // rejected contribution.
        const { deps, calls, enqueued, sent } = watchDeps({ data: null, error: { message: 'ledger down' } });
        currentDeps = deps;
        const res = await post(T1, WATCH);
        expect(res.status).toBe(200);
        expect(enqueued).toHaveLength(1);
        expect(sent).toHaveLength(1);
        expect(calls.some((c) => c.name === 'record_ais_watch')).toBe(true);
        // No standing echoed — the client shows its last known card instead.
        expect(await res.json()).not.toHaveProperty('watch');
    });

    it('stays silent for a client that sends no envelope', async () => {
        // Old builds keep working and simply earn nothing, rather than being
        // credited a zero that would look like a broken gateway.
        const { deps, calls } = watchDeps();
        currentDeps = deps;
        await post(T1);
        expect(calls.some((c) => c.name === 'record_ais_watch')).toBe(false);
    });

    it('clamps an absurd claim rather than trusting it', async () => {
        // A client claiming a day of connected time every five minutes buys
        // nothing: the header is capped here and bounded against wall clock
        // again in record_ais_watch. Belt and braces, because this is the one
        // number that mints standing.
        const { deps, calls } = watchDeps();
        currentDeps = deps;
        await post('', { ...WATCH, 'X-Thalassa-Connected': '999999', 'X-Thalassa-Reconnects': '-5' });
        const credit = calls.find((c) => c.name === 'record_ais_watch')?.args;
        expect(credit?.p_connected_s).toBe(3600);
        expect(credit?.p_reconnects).toBe(0);
    });
});
