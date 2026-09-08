/**
 * A Pi pairing says which hull the Pi is bolted to.
 *
 * Shane, 2026-09-08: the only way onto someone else's boat is an invite, and
 * a skipper who sells her or finishes a delivery Releases her. Release cuts
 * only the relay rows matched to the released boat and reports the rest as
 * unmatched — so the pair must stamp `pi_diary_relays.boat_id`, the server
 * must never take a caller's word for whose boat that is, and a released
 * phone must not quietly re-assert a pairing from memory while it is still
 * on the boat LAN.
 *
 * The edge function runs on Deno and is not unit-tested here, so its half is
 * pinned by source (the VesselTelemetryContract pattern). The phone's half is
 * exercised for real.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    pushConfig: vi.fn(),
    setPolicy: vi.fn(),
    status: {
        diaryRelayConfigured: false as boolean,
        diaryRelayOwnerId: undefined as string | undefined,
        diaryRelayId: 'pi_test_1234567890',
    },
    activeVesselId: '2e39983f-5d86-4dcb-b6f9-34df05c08d90' as string | null,
}));

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { post: vi.fn() } }));

// piPublicBetaBoundary imports piTls, which registers a Capacitor plugin at
// module load; the same stub the existing DiaryRelayTransport test uses.
vi.mock('../services/piTls', () => ({
    piRequest: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => true,
}));

// The Pi accepts whatever it is handed; this test is about the pairing step
// in front of it, not the hand-off itself.
vi.mock('../services/PiPairingService', () => ({
    pinnedPiRequest: async () => ({
        status: 200,
        headers: {},
        data: JSON.stringify({ accepted: true, status: 'queued' }),
        peerSpki: '',
    }),
    getPairing: () => null,
}));

vi.mock('../services/ConnectionPriorityService', () => ({
    getConnectionState: () => ({ quality: 'high', type: 'wifi', effectiveDownlink: 20, saveData: false }),
}));

vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ key: 'user:skipper', userId: 'skipper', generation: 1 }),
    isAuthIdentityScopeCurrent: () => true,
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        getStatus: () => ({ ...mocks.status }),
        baseUrl: 'https://calypso.local:3001',
        setDiaryRelayInternetPolicy: mocks.setPolicy,
        pushConfig: mocks.pushConfig,
    },
}));

// The transport reads the active OWNED vessel from the settings store at call
// time; `settings.satelliteMode` is what networkPolicy reads from the same store.
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { satelliteMode: false }, activeVesselId: mocks.activeVesselId }),
    },
}));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: vi.fn(async () => ({ Authorization: 'Bearer session' })),
}));

vi.mock('../services/supabase', () => ({ supabaseUrl: 'https://example.supabase.co' }));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { forgetRelayPairings, handoffDiaryToPi, type DiaryRelayEnvelope } from '../services/DiaryRelayTransport';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const RELAY_ID = 'pi_test_1234567890';
const FRESH_TOKEN = 'ab'.repeat(32);

const envelope: DiaryRelayEnvelope = {
    client_operation_id: 'diary_pair_boat_1',
    client_revision: 1,
    title: 'Off the mooring',
    body: 'Slipped at first light.',
    mood: 'good',
    photos: [],
    audio_url: null,
    latitude: null,
    longitude: null,
    location_name: '',
    weather_summary: '',
    voyage_id: null,
    boat_id: '2e39983f-5d86-4dcb-b6f9-34df05c08d90',
    tags: [],
    is_public: false,
    created_at: '2026-09-08T00:00:00.000Z',
};

/** The JSON body of the n-th call the phone made to the diary-relay function. */
function pairBody(callIndex: number): Record<string, unknown> {
    const init = mocks.fetch.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
    expect(init?.body).toBeTruthy();
    return JSON.parse(init!.body!) as Record<string, unknown>;
}

function freshPairing() {
    return { ok: true, json: async () => ({ relay_id: RELAY_ID, owner_id: 'skipper', token: FRESH_TOKEN }) };
}

describe('the phone names the hull when it pairs a Pi', () => {
    beforeEach(() => {
        mocks.status.diaryRelayConfigured = false;
        mocks.status.diaryRelayOwnerId = undefined;
        mocks.activeVesselId = '2e39983f-5d86-4dcb-b6f9-34df05c08d90';
        mocks.fetch.mockReset().mockResolvedValue(freshPairing());
        mocks.pushConfig.mockReset().mockResolvedValue(true);
        mocks.setPolicy.mockReset().mockResolvedValue(true);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        vi.stubGlobal('fetch', mocks.fetch);
        // Module-level memory survives between tests; start each one unpaired.
        forgetRelayPairings('user:skipper');
    });

    it('sends the active owned vessel as boat_id in the pair body', async () => {
        await expect(handoffDiaryToPi(envelope)).resolves.toMatchObject({ accepted: true, status: 'queued' });

        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.fetch.mock.calls[0]?.[0]).toBe('https://example.supabase.co/functions/v1/diary-relay');
        expect(pairBody(0)).toEqual({
            action: 'pair',
            relay_id: RELAY_ID,
            boat_id: '2e39983f-5d86-4dcb-b6f9-34df05c08d90',
        });
        // The fresh token still reaches the Pi exactly as before.
        expect(mocks.pushConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                diaryRelayId: RELAY_ID,
                diaryRelayOwnerId: 'skipper',
                diaryRelayToken: FRESH_TOKEN,
            }),
        );
    });

    it('sends boat_id: null when no vessel is chosen — the server falls back to the account’s active-vessel row', async () => {
        mocks.activeVesselId = null;

        await handoffDiaryToPi(envelope);

        const body = pairBody(0);
        expect(body).toHaveProperty('boat_id', null);
        expect(body.action).toBe('pair');
    });

    it('forgetRelayPairings clears the remembered pairing so the next attempt asks the server, not memory', async () => {
        // 1. Pair for real: one network round-trip.
        await handoffDiaryToPi(envelope);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        // 2. The Pi now reports its relay configured but has not said whose it
        //    is. Within the TTL the phone trusts its own memory of the pairing
        //    and only refreshes the WAN policy — no network call.
        mocks.status.diaryRelayConfigured = true;
        mocks.status.diaryRelayOwnerId = undefined;
        mocks.pushConfig.mockClear();
        await handoffDiaryToPi(envelope);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.pushConfig).toHaveBeenCalledWith({
            supabaseUrl: '',
            supabaseAnonKey: '',
            diaryRelayAllowInternet: true,
        });

        // 3. Release forgets this account's pairings. Same Pi, same LAN — the
        //    phone must now go back to the server instead of trusting memory.
        forgetRelayPairings('user:skipper');
        await handoffDiaryToPi(envelope);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(pairBody(1)).toMatchObject({ action: 'pair', relay_id: RELAY_ID });
    });

    it('forgetRelayPairings touches only the named scope', async () => {
        await handoffDiaryToPi(envelope);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        mocks.status.diaryRelayConfigured = true;
        mocks.status.diaryRelayOwnerId = undefined;
        forgetRelayPairings('user:someone-else');
        await handoffDiaryToPi(envelope);

        // Another account's release must not make this account re-pair.
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('the pair body is built from the literal the source promises', () => {
        // Belt and braces for the behavioural checks above: if the body shape
        // is ever renamed, this names the line that changed.
        const transport = read('services/DiaryRelayTransport.ts');
        expect(transport).toContain("body: JSON.stringify({ action: 'pair', relay_id: relayId, boat_id: boatId })");
        expect(transport).toContain('export function forgetRelayPairings(scopeKey: string): void');
    });
});

describe('the diary-relay edge function stamps boat_id on pair (source pins — Deno is not unit-tested here)', () => {
    const edge = read('supabase/functions/diary-relay/index.ts');
    const telemetry = read('supabase/functions/telemetry-relay/index.ts');

    const between = (source: string, start: string, end: string): string => {
        const from = source.indexOf(start);
        expect(from, `missing "${start}"`).toBeGreaterThan(-1);
        const rest = source.slice(from);
        const to = rest.indexOf(end);
        expect(to, `missing "${end}" after "${start}"`).toBeGreaterThan(-1);
        return rest.slice(0, to);
    };

    it('the pi_diary_relays insert carries the server-resolved boat_id, never the caller’s hint', () => {
        const insert = between(edge, ".from('pi_diary_relays').insert({", '});');
        expect(insert).toContain('boat_id: boatId,');
        expect(insert).toContain('owner_id: caller.userId,');
        expect(insert).not.toContain('body.boat_id');

        // The caller's hint enters the function exactly once, and only as
        // input to the ownership check — nothing else reads it. Count code,
        // not the comments that explain why.
        const code = edge
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
        expect(code.match(/body\.boat_id/g)).toHaveLength(1);
        expect(edge).toContain('resolvePairBoatId(admin, caller.userId, nullableBoatId(body.boat_id))');
    });

    it('a candidate boat_id is believed only when the caller owns that boat and it is still active', () => {
        const proof = between(edge, 'async function ownedActiveBoatId(', '\n}\n');
        const ownership = between(proof, ".from('boats')", '.maybeSingle();');
        expect(ownership).toContain(".eq('id', boatId)");
        expect(ownership).toContain(".eq('owner_id', ownerId)");
        expect(ownership).toContain(".is('archived_at', null)");
        // A lookup failure is "not proven", never a stamp.
        expect(between(proof, 'if (error) {', '}')).toContain('return null;');
    });

    it('every candidate passes the ownership proof — the phone’s hint AND the active-vessel fallback', () => {
        // user_active_vessels may point at a boat the caller merely crews on
        // (validate_user_active_vessel, 20260727120000 permits boat_members),
        // so the fallback is not exempt: a crew member who TOFU-pairs the
        // skipper's Pi must not stamp the skipper's hull onto their own row.
        const resolver = between(edge, 'async function resolvePairBoatId(', '\n}\n');
        expect(resolver).toContain('ownedActiveBoatId(admin, ownerId, requested)');
        expect(resolver).toContain('return ownedActiveBoatId(admin, ownerId, candidate);');
        // The resolver never queries boats itself and never returns a raw row
        // value: each return is the proof's answer or null.
        expect(resolver).not.toContain(".from('boats')");
        const returns = resolver.match(/return [^;]+;/g) ?? [];
        expect(returns.length).toBeGreaterThanOrEqual(3);
        for (const line of returns) {
            expect(['return owned;', 'return null;', 'return ownedActiveBoatId(admin, ownerId, candidate);']).toContain(
                line,
            );
        }
        // A miss falls back rather than refusing, and never writes the hint.
        expect(resolver).toContain('pair named a boat the caller does not own');
    });

    it('falls back to the caller’s active vessel exactly as telemetry-relay reads it', () => {
        const resolver = between(edge, 'async function resolvePairBoatId(', '\n}\n');
        for (const line of [
            ".from('user_active_vessels')",
            ".select('boat_id')",
            ".eq('user_id', ",
            '.maybeSingle();',
        ]) {
            expect(resolver).toContain(line);
            expect(telemetry).toContain(line);
        }
    });

    it('an existing same-owner row with no boat_id is back-filled once, and only while still NULL', () => {
        const backfill = between(edge, 'async function backfillPairBoatId(', '\n}\n');
        // Owner check comes first: a foreign row is refused before any write.
        expect(backfill.indexOf('relay.owner_id !== ownerId')).toBeLessThan(
            backfill.indexOf(".from('pi_diary_relays')"),
        );
        const update = between(backfill, ".from('pi_diary_relays')", ';');
        expect(update).toContain('.update({ boat_id: boatId');
        expect(update).toContain(".eq('relay_id', relayId)");
        expect(update).toContain(".eq('owner_id', ownerId)");
        expect(update).toContain(".is('boat_id', null)");
        // Best effort: a failed back-fill is logged, never turned into a pairing failure.
        expect(backfill).toContain('pair boat back-fill failed');
        expect(backfill).toContain('Promise<void>');
        expect(backfill).not.toContain('json(');

        // Both existing-row paths stamp before answering, and the answer itself
        // stays the three-argument builder the revision-protocol test pins.
        expect(edge).toContain('await backfillPairBoatId(admin, beforeClaim.relay, relayId, caller.userId, boatId);');
        expect(edge).toContain('return existingPairingResponse(beforeClaim.relay, relayId, caller.userId);');
        expect(edge).toContain('await backfillPairBoatId(admin, afterConflict.relay, relayId, caller.userId, boatId);');
        expect(edge).toContain('return existingPairingResponse(afterConflict.relay, relayId, caller.userId);');
    });

    it('the pairing lookup reads boat_id so the back-fill can see a NULL', () => {
        expect(edge).toContain(".select('owner_id, enabled, boat_id')");
    });
});
