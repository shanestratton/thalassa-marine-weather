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
        expect(await res.json()).toEqual({ accepted: 2, decoded: 2 });
        expect(enqueued).toHaveLength(2);
        // AIVDM forwarded as-is; own-ship AIVDO rewritten as a receipt.
        expect(sent[0]).toBe(T1);
        expect(sent[1].startsWith('!AIVDM,')).toBe(true);
    });

    it('silently drops garbage, wrong talkers and bad checksums', async () => {
        const { deps, enqueued, sent } = makeDeps();
        currentDeps = deps;
        const res = await post(['$GPGGA,junk*00', 'not a sentence', T1.replace('17Ojo', '17Ojp'), T1].join('\n'));
        expect(await res.json()).toEqual({ accepted: 1, decoded: 1 });
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
