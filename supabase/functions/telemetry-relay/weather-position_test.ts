import { recordWeatherPosition } from './weather-position.ts';
const now = Date.parse('2026-10-17T07:00:00Z'),
    revision = '30000000-0000-4000-8000-000000000001',
    identity = { ownerId: revision, relayId: 'fictional_relay_0001' };
const proof = {
    schema: 1,
    revision,
    selfKey: 'a'.repeat(64),
    sourceKey: 'b'.repeat(64),
    lat: 0,
    lon: 0,
    at: now - 1000,
};
const request = { schema: 1, revision, selfKey: proof.selfKey, sourceKey: proof.sourceKey, expiresAt: now + 600000 };
const equal = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Position contract assertion failed');
};
Deno.test('authenticated identity selects authoritative relay, fixed receipt RPC, original clock and timezone', async () => {
    const calls: unknown[] = [];
    const admin = {
        rpc: async (name: string, body: Record<string, unknown>) => {
            calls.push([name, body]);
            return { data: request, error: null };
        },
    };
    equal(
        await recordWeatherPosition(admin, identity, { source: 'pi', weather_position_v1: proof }, (lat, lon) => {
            equal([lat, lon], [0, 0]);
            return 'UTC';
        }, now),
        request,
    );
    equal(calls, [['weather_position_telemetry', {
        p_owner_id: identity.ownerId,
        p_relay_id: identity.relayId,
        p_proof: proof,
        p_zone: 'UTC',
    }]]);
});
Deno.test('missing/wrong/extra/future/stale proof is retired, never filled from selected-account telemetry or phone data', async () => {
    for (
        const body of [
            { source: 'device', weather_position_v1: proof },
            { source: 'pi', lat: 20, lon: 30 },
            { source: 'pi', weather_position_v1: { ...proof, at: now + 1 } },
            { source: 'pi', weather_position_v1: { ...proof, at: now - 14000 } },
            { source: 'pi', weather_position_v1: { ...proof, rawPath: 'navigation.position' } },
        ]
    ) {
        let posted: unknown;
        const admin = {
            rpc: async (_name: string, args: Record<string, unknown>) => {
                posted = args;
                return { data: request, error: null };
            },
        };
        equal(
            await recordWeatherPosition(admin, identity, body, () => {
                throw new Error('No geographic lookup for unqualified data');
            }, now),
            request,
        );
        equal(posted, { p_owner_id: identity.ownerId, p_relay_id: identity.relayId, p_proof: null, p_zone: null });
    }
});
Deno.test('held/missing backend or malformed request cannot break legacy telemetry or claim enabled sharing', async () => {
    for (const data of [null, { ...request, url: 'https://invalid' }, { ...request, expiresAt: now }]) {
        equal(
            await recordWeatherPosition(
                { rpc: async () => ({ data, error: null }) },
                identity,
                {
                    source: 'pi',
                    weather_position_v1: proof,
                },
                () => 'UTC',
                now,
            ),
            null,
        );
    }
    equal(
        await recordWeatherPosition(
            { rpc: async () => ({ data: request, error: { message: 'held' } }) },
            identity,
            {},
            () => 'UTC',
            now,
        ),
        null,
    );
});
