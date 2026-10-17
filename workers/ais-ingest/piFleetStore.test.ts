import { createClient } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { fleetRelayTokenHash } from './fleetCrypto.js';
import { postgresPiFleetStore } from './piFleetStore.js';

const ownerId = '10000000-0000-4000-8000-000000000001';
const boatId = '20000000-0000-4000-8000-000000000001';
const relayId = 'fictional-relay-140';
const token = 'e'.repeat(64);
const row = {
    owner_id: ownerId,
    boat_id: boatId,
    relay_id: relayId,
    token_hash: fleetRelayTokenHash(token),
    enabled: true,
};
afterEach(() => vi.restoreAllMocks());

it('the actual SDK retains the relay filter, nullable row and five-second abort signal', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/rest/v1/pi_diary_relays');
        expect(url.searchParams.get('relay_id')).toBe(`eq.${relayId}`);
        expect(url.searchParams.get('select')).toBe('owner_id,boat_id,relay_id,token_hash,enabled');
        expect(init?.signal).toBe(controller.signal);
        return new Response(JSON.stringify([row]), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = createClient('https://fictional.invalid', 'fixture-only-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: request },
    });
    await expect(postgresPiFleetStore(client).relay(ownerId, boatId, relayId, token)).resolves.toEqual({
        ownerId,
        boatId,
        relayId,
        tokenHash: row.token_hash,
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(request).toHaveBeenCalledTimes(1);
});

it('the actual SDK refuses absent, disabled, cross-owner and wrong-token relay authority', async () => {
    const request = vi.fn<typeof fetch>();
    const client = createClient('https://fictional.invalid', 'fixture-only-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: request },
    });
    const store = postgresPiFleetStore(client);
    for (const rows of [[], [{ ...row, enabled: false }], [{ ...row, owner_id: boatId }], [row]]) {
        request.mockResolvedValueOnce(
            new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } }),
        );
        await expect(store.relay(ownerId, boatId, relayId, 'f'.repeat(64))).resolves.toBeNull();
    }
    expect(request).toHaveBeenCalledTimes(4);
});

it('the actual SDK carries cancellation through nullable-row handling and fails closed', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const request = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException('Fictional request cancelled', 'AbortError');
    });
    const client = createClient('https://fictional.invalid', 'fixture-only-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: request },
    });
    await expect(postgresPiFleetStore(client).relay(ownerId, boatId, relayId, token)).rejects.toThrow(
        'Fleet relay authority unavailable',
    );
    expect(controller.signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
});
