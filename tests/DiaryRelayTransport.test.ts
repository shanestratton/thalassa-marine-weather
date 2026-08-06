import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    post: vi.fn(),
    fetch: vi.fn(),
    setPolicy: vi.fn(),
    satellite: false,
}));

vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { post: mocks.post },
}));
vi.mock('../services/piTls', () => ({
    piRequest: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => true,
}));
// The Pi handoff moved onto the pinned transport when the boat LAN went to
// TLS (2026-08-07). Keep driving it from `mocks.post` so the assertions below
// still describe "what was sent to the Pi" — only the pipe changed. The
// adapter mirrors pinnedPiRequest's contract: body as a JSON string.
vi.mock('../services/PiPairingService', () => ({
    pinnedPiRequest: async (options: { url: string; data?: unknown }) => {
        const res = await mocks.post({
            url: options.url,
            data: typeof options.data === 'string' ? options.data : JSON.stringify(options.data),
        });
        return {
            status: res?.status ?? 599,
            headers: res?.headers ?? {},
            data: typeof res?.data === 'string' ? res.data : JSON.stringify(res?.data ?? null),
            peerSpki: '',
        };
    },
    getPairing: () => null,
}));

vi.mock('../services/ConnectionPriorityService', () => ({
    getConnectionState: () => ({
        quality: mocks.satellite ? 'low' : 'high',
        type: mocks.satellite ? 'satellite' : 'wifi',
        effectiveDownlink: mocks.satellite ? 0.02 : 20,
        saveData: mocks.satellite,
    }),
}));

vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ key: 'user:skipper', userId: 'skipper', generation: 1 }),
    isAuthIdentityScopeCurrent: () => true,
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        getStatus: () => ({
            diaryRelayConfigured: true,
            diaryRelayOwnerId: 'skipper',
            diaryRelayId: 'pi_test_1234567890',
        }),
        baseUrl: 'https://calypso.local:3001',
        setDiaryRelayInternetPolicy: mocks.setPolicy,
    },
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { satelliteMode: mocks.satellite } }) },
}));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: vi.fn(async () => ({ Authorization: 'Bearer session' })),
}));

vi.mock('../services/supabase', () => ({ supabaseUrl: 'https://example.supabase.co' }));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handoffDiaryToPi, type DiaryRelayEnvelope } from '../services/DiaryRelayTransport';

const envelope: DiaryRelayEnvelope = {
    client_operation_id: 'diary_transport_1',
    client_revision: 1,
    title: 'A quiet anchorage',
    body: 'The tide turned at dusk.',
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
    created_at: '2026-07-27T00:00:00.000Z',
};

describe('DiaryRelayTransport paired Pi handoff', () => {
    beforeEach(() => {
        mocks.satellite = false;
        mocks.fetch.mockReset().mockRejectedValue(new Error('boat LAN has no WAN'));
        mocks.setPolicy.mockReset().mockResolvedValue(true);
        mocks.post.mockReset().mockResolvedValue({
            status: 200,
            data: { accepted: true, status: 'queued', client_operation_id: envelope.client_operation_id },
        });
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        vi.stubGlobal('fetch', mocks.fetch);
    });

    it('uses an already paired same-owner Pi even when the phone cannot reach Supabase', async () => {
        await expect(handoffDiaryToPi(envelope)).resolves.toMatchObject({ accepted: true, status: 'queued' });

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.post).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://calypso.local:3001/api/diary/entries' }),
        );
        const request = mocks.post.mock.calls[0]?.[0] as { data?: string } | undefined;
        expect(request?.data).toBeTruthy();
        expect(JSON.parse(request!.data!)).toMatchObject({
            entry: { boat_id: envelope.boat_id },
            allowInternet: true,
        });
    });

    it('does not hand off while a satellite gate cannot be durably closed', async () => {
        mocks.satellite = true;
        mocks.setPolicy.mockResolvedValue(false);

        await expect(handoffDiaryToPi(envelope)).resolves.toBeNull();

        expect(mocks.post).not.toHaveBeenCalled();
        expect(mocks.setPolicy).toHaveBeenCalledWith(false);
    });
});
