import { describe, expect, it } from 'vitest';
import { createPiInternetAisHandler, type PiInternetAisReader } from '../supabase/functions/pi-internet-ais/core';

const now = Date.parse('2026-10-17T09:00:00Z');
const body = {
    schema: 1,
    lat: -27.2,
    lon: 153.1,
    measuredAt: now - 1000,
    ownMmsi: 503111111,
    radiusNm: 25,
    limit: 100,
};
const owner = { ownerId: '11111111-1111-4111-8111-111111111111', relayId: 'synthetic-relay-0001' };
const row = {
    mmsi: 503222222,
    lat: -27.21,
    lon: 153.11,
    cog: 90,
    sog: 10,
    updated_at: new Date(now - 3000).toISOString(),
    data_source: 'aisstream',
    private_note: 'must not leave the database',
};
const request = (value: unknown = body, signal?: AbortSignal) =>
    new Request('https://synthetic.supabase.co/functions/v1/pi-internet-ais', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-thalassa-pi-relay-id': owner.relayId,
            'x-thalassa-pi-relay-token': 'a'.repeat(64),
        },
        body: JSON.stringify(value),
        signal,
    });
function deps(): PiInternetAisReader {
    return {
        enabled: () => true,
        now: () => now,
        authenticate: async (credential) =>
            credential?.relayId === owner.relayId ? { ...owner } : { status: 401, error: 'missing' },
        deleted: async () => false,
        quota: async () => true,
        coverage: async () => 'limited',
        query: async () => [{ ...row }],
    };
}
describe('scoped Pi internet AIS Edge boundary', () => {
    it('stays off by default and refuses methods before auth or database work', async () => {
        const d = deps();
        d.enabled = () => false;
        d.authenticate = async () => {
            throw Error('must not run');
        };
        const handler = createPiInternetAisHandler(d);
        expect((await handler(request())).status).toBe(503);
        expect((await handler(new Request('https://synthetic.invalid', { method: 'GET' }))).status).toBe(405);
    });
    it('returns only bounded original-time public observations under the actual relay owner quota', async () => {
        const d = deps();
        const quotaOwners: string[] = [];
        d.quota = async (id) => {
            quotaOwners.push(id);
            return true;
        };
        d.query = async () => [
            row,
            { ...row, mmsi: 503333333, data_source: 'unknown' },
            { ...row, mmsi: 503444444, updated_at: new Date(now - 120001).toISOString() },
            { ...row, mmsi: body.ownMmsi },
        ];
        const response = await createPiInternetAisHandler(d)(request());
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
            schema: 1,
            targets: [
                { mmsi: row.mmsi, lat: row.lat, lon: row.lon, cog: 90, sog: 10, at: now - 3000, provider: 'aisstream' },
            ],
            coverage: 'limited',
            truncated: false,
        });
        expect(quotaOwners).toEqual([owner.ownerId]);
    });
    it('does not accept caller identity/URL, a stale own fix or enlarged query bounds', async () => {
        for (const extra of [
            { ownerId: owner.ownerId },
            { url: 'https://untrusted.invalid' },
            { limit: 101 },
            { radiusNm: 200 },
            { measuredAt: now - 20001 },
        ]) {
            const d = deps();
            d.query = async () => {
                throw Error('must not query');
            };
            expect((await createPiInternetAisHandler(d)(request({ ...body, ...extra }))).status).toBe(400);
        }
    });
    it('held coverage performs no vessel query and makes no all-clear claim', async () => {
        const d = deps();
        d.coverage = async () => 'held';
        d.query = async () => {
            throw Error('must not query');
        };
        const response = await createPiInternetAisHandler(d)(request());
        expect(await response.json()).toEqual({ schema: 1, targets: [], coverage: 'held', truncated: false });
    });
    it('revoked or replaced relay authority after the query cannot emit its candidate', async () => {
        for (const replacement of [
            { status: 401 as const, error: 'revoked' },
            { ...owner, ownerId: '22222222-2222-4222-8222-222222222222' },
        ]) {
            const d = deps();
            let calls = 0;
            d.authenticate = async () => (++calls === 1 ? owner : replacement);
            const response = await createPiInternetAisHandler(d)(request());
            expect(response.status).toBe(401);
            expect(JSON.stringify(await response.json())).not.toContain(String(row.mmsi));
        }
    });
    it('both initial and late deletion tombstones refuse observations', async () => {
        for (const after of [false, true]) {
            const d = deps();
            let queried = false;
            d.query = async () => {
                queried = true;
                return [row];
            };
            d.deleted = async () => (after ? queried : true);
            expect((await createPiInternetAisHandler(d)(request())).status).toBe(401);
        }
    });
    it('quota refusal, missing credentials and corrupt oversized query results fail closed', async () => {
        const limited = deps();
        limited.quota = async () => false;
        expect((await createPiInternetAisHandler(limited)(request())).status).toBe(429);
        expect(
            (
                await createPiInternetAisHandler(deps())(
                    new Request('https://synthetic.invalid', { method: 'POST', body: '{}' }),
                )
            ).status,
        ).toBe(401);
        const corrupt = deps();
        corrupt.query = async () => Array(101).fill(row);
        expect((await createPiInternetAisHandler(corrupt)(request())).status).toBe(503);
    });
    it('an aborted request releases a never-resolving query without a success fallback', async () => {
        const d = deps();
        const controller = new AbortController();
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        d.query = async () => {
            started();
            return new Promise(() => undefined);
        };
        const response = createPiInternetAisHandler(d)(request(body, controller.signal));
        await ready;
        controller.abort();
        expect((await response).status).toBe(503);
    });
});
