import { describe, expect, it, vi } from 'vitest';
import {
    createLightningWatchHandler,
    type LightningWatchPorts,
} from '../supabase/functions/licensed-lightning-watch/handler';
import { createLightningDeliveryGuard } from '../supabase/functions/send-push/lightning-delivery';
const NOW = 1792230000000;
const id = (n: number) => `${n}0000000-0000-4000-8000-000000000001`;
const row = {
    boat_id: id(1),
    revision: id(2),
    lease: id(3),
    position_revision: id(4),
    position_at: NOW - 1000,
    latitude: -27,
    longitude: 154,
};
const original = {
    success: true,
    error: null,
    response: [
        {
            id: 'original-pulse',
            loc: { lat: -27, long: 154 },
            ob: { timestamp: NOW / 1000 - 10, pulse: { type: 'cg', peakamp: 4 } },
        },
    ],
};
function ports(extra: Partial<LightningWatchPorts> = {}): LightningWatchPorts {
    return {
        now: () => NOW,
        work: vi.fn(async () => [row]),
        current: vi.fn(async () => true),
        claim: vi.fn(async () => true),
        licensed: {
            now: () => NOW,
            authorize: async () => null,
            reserve: vi.fn(async () => true),
            admission: () => ({
                clientId: 'fixture-id',
                secret: 'fixture-only',
                expiresAt: NOW + 86400000,
                display: true,
                push: true,
            }),
            fetch: vi.fn(async () => Response.json(original)),
        },
        ...extra,
    };
}
const request = (body = '{}', auth = 'fixture-service', query = '') =>
    new Request('https://fixture.invalid/watch' + query, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + auth },
        body,
    });
describe('Held service-only licensed lightning watch', () => {
    it('refuses missing or user credentials before constructing privileged dependencies', async () => {
        const factory = vi.fn(() => ports());
        const handler = createLightningWatchHandler(() => 'fixture-service', factory);
        expect((await handler(request('{}', 'ordinary-user'))).status).toBe(401);
        expect(factory).not.toHaveBeenCalled();
    });
    it('refuses caller coordinates, destinations, queries and nonempty body before privileged work', async () => {
        const factory = vi.fn(() => ports()),
            handler = createLightningWatchHandler(() => 'fixture-service', factory);
        for (const body of [
            '{"latitude":-27}',
            JSON.stringify({ url: 'https://untrusted.invalid' }),
            '[]',
            'x'.repeat(257),
        ])
            expect((await handler(request(body))).status).toBe(400);
        expect((await handler(request('{}', 'fixture-service', '?latitude=-27'))).status).toBe(400);
        expect(factory).not.toHaveBeenCalled();
    });
    it('holds unlicensed worker before requesting positions or paid observations', async () => {
        const p = ports();
        p.licensed.admission = () => null;
        expect(
            (
                await createLightningWatchHandler(
                    () => 'fixture-service',
                    () => p,
                )(request())
            ).status,
        ).toBe(503);
        expect(p.work).not.toHaveBeenCalled();
        expect(p.licensed.fetch).not.toHaveBeenCalled();
    });
    it('preserves fixed20NM query and original pulse into a one-use atomic claim', async () => {
        const p = ports(),
            response = await createLightningWatchHandler(
                () => 'fixture-service',
                () => p,
            )(request());
        expect(await response.json()).toEqual({ schema: 1, work: 1, reads: 1, claimed: 1 });
        expect(p.licensed.fetch).toHaveBeenCalledTimes(1);
        expect(p.claim).toHaveBeenCalledTimes(1);
        expect(p.claim).toHaveBeenCalledWith(
            row,
            expect.objectContaining({ id: 'original-pulse', time: NOW - 10000, lat: -27, lon: 154 }),
            expect.any(AbortSignal),
        );
        const url = new URL(String(vi.mocked(p.licensed.fetch).mock.calls[0][0]));
        expect(url.origin + url.pathname).toBe('https://data.api.xweather.com/lightning/closest');
        expect(url.searchParams.get('radius')).toBe('37.04km');
    });
    it.each([
        null,
        [{ ...row, position_at: NOW - 120000 }],
        [{ ...row, position_at: NOW + 1 }],
        [{ ...row, lease: 'bad' }],
        [{ ...row, url: 'https://untrusted.invalid' }],
        [row, row],
        Array.from({ length: 9 }, () => row),
    ])(
        'refuses malformed, stale, future, duplicated and oversized lease batches before provider access %#',
        async (value) => {
            const p = ports({ work: async () => value });
            expect(
                (
                    await createLightningWatchHandler(
                        () => 'fixture-service',
                        () => p,
                    )(request())
                ).status,
            ).toBe(503);
            expect(p.licensed.fetch).not.toHaveBeenCalled();
            expect(p.claim).not.toHaveBeenCalled();
        },
    );
    it('rechecks revoked consent after shared paid reservation without a provider request', async () => {
        let active = true;
        const p = ports({ current: async () => active });
        p.licensed.reserve = async () => {
            active = false;
            return true;
        };
        expect(
            (
                await createLightningWatchHandler(
                    () => 'fixture-service',
                    () => p,
                )(request())
            ).status,
        ).toBe(200);
        expect(p.licensed.fetch).not.toHaveBeenCalled();
        expect(p.claim).not.toHaveBeenCalled();
    });
    it('rechecks the live lease immediately before the actual HTTP read', async () => {
        let checks = 0;
        const p = ports({ current: async () => ++checks < 4 });
        expect(
            (
                await createLightningWatchHandler(
                    () => 'fixture-service',
                    () => p,
                )(request())
            ).status,
        ).toBe(200);
        expect(checks).toBe(4);
        expect(p.licensed.fetch).not.toHaveBeenCalled();
        expect(p.claim).not.toHaveBeenCalled();
    });
    it('never queues a pulse when consent is revoked while its response is pending', async () => {
        let active = true;
        const p = ports({ current: async () => active });
        p.licensed.fetch = vi.fn(async () => {
            active = false;
            return Response.json(original);
        });
        expect(
            (
                await createLightningWatchHandler(
                    () => 'fixture-service',
                    () => p,
                )(request())
            ).status,
        ).toBe(200);
        expect(p.claim).not.toHaveBeenCalled();
    });
    it.each(['work', 'current'] as const)(
        'rejects an uncooperative late %s result after cancellation',
        async (stage) => {
            const controller = new AbortController();
            const p = ports();
            if (stage === 'work')
                p.work = vi.fn(async () => {
                    controller.abort();
                    return [row];
                });
            else
                p.current = vi.fn(async () => {
                    controller.abort();
                    return true;
                });
            const response = await createLightningWatchHandler(
                () => 'fixture-service',
                () => p,
            )(new Request(request(), { signal: controller.signal }));
            expect(response.status).toBe(503);
            expect(p.licensed.reserve).not.toHaveBeenCalled();
            expect(p.licensed.fetch).not.toHaveBeenCalled();
            expect(p.claim).not.toHaveBeenCalled();
        },
    );
    it('never emits an all-clear for empty, expired or future source observations', async () => {
        for (const response of [
            { ...original, response: [] },
            {
                ...original,
                response: [
                    { ...original.response[0], ob: { ...original.response[0].ob, timestamp: NOW / 1000 - 301 } },
                ],
            },
            {
                ...original,
                response: [{ ...original.response[0], ob: { ...original.response[0].ob, timestamp: NOW / 1000 + 1 } }],
            },
        ]) {
            const p = ports();
            p.licensed.fetch = vi.fn(async () => Response.json(response));
            expect(
                (
                    await createLightningWatchHandler(
                        () => 'fixture-service',
                        () => p,
                    )(request())
                ).status,
            ).toBe(200);
            expect(p.claim).not.toHaveBeenCalled();
        }
    });
    it('keeps unknown database permission fail closed without silent provider retries', async () => {
        const p = ports({ current: async () => null });
        expect(
            (
                await createLightningWatchHandler(
                    () => 'fixture-service',
                    () => p,
                )(request())
            ).status,
        ).toBe(200);
        expect(p.licensed.fetch).not.toHaveBeenCalled();
        expect(p.claim).not.toHaveBeenCalled();
    });
});
describe('Lightning original expiry and current delivery authority', () => {
    const data = {
        type: 'lightning_nearby',
        provider: 'xweather',
        source_at: NOW - 1000,
        expires_at: NOW + 59000,
        pulse_id: 'original-pulse',
    };
    it('rechecks owner authority independently at every invocation', async () => {
        let active = true;
        const read = vi.fn(async () => active),
            guard = createLightningDeliveryGuard(id(1), data, read, () => NOW);
        expect(await guard()).toBe('allow');
        active = false;
        expect(await guard()).toBe('retire');
        expect(read).toHaveBeenCalledTimes(2);
    });
    it('retires expired source notices before reading private owner data', async () => {
        const read = vi.fn(async () => true),
            guard = createLightningDeliveryGuard(id(1), { ...data, expires_at: NOW }, read, () => NOW);
        expect(await guard()).toBe('retire');
        expect(read).not.toHaveBeenCalled();
    });
    it('does not turn unavailable owner checks into send permission', async () => {
        expect(
            await createLightningDeliveryGuard(
                id(1),
                data,
                async () => null,
                () => NOW,
            )(),
        ).toBe('unavailable');
    });
});
