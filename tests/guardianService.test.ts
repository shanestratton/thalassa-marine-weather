/**
 * GuardianService unit tests — Maritime Neighborhood Watch.
 *
 * Tests cover:
 * - Service initialization and state management
 * - Profile CRUD operations (with mocked Supabase)
 * - ARM / DISARM state transitions
 * - Hail message constants
 * - Weather template constants
 * - Pub/sub notification system
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock supabase module
const mockRpc = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();
const mockGetUser = vi.fn();
const mockAcquireFreshOwnshipPosition = vi.fn();

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: () => mockGetUser(),
        },
        from: () => ({
            select: (...args: unknown[]) => {
                mockSelect(...args);
                return {
                    eq: (...eqArgs: unknown[]) => {
                        mockEq(...eqArgs);
                        return { maybeSingle: () => mockMaybeSingle() };
                    },
                };
            },
            insert: (...args: unknown[]) => mockInsert(...args),
            upsert: (...args: unknown[]) => mockUpsert(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        }),
        rpc: (...args: unknown[]) => mockRpc(...args),
    },
}));

// Mock LocationStore
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => ({ lat: -36.8485, lon: 174.7633 }), // Auckland
    },
}));

vi.mock('../services/ownshipPosition', () => ({
    acquireFreshOwnshipPosition: (...args: unknown[]) => mockAcquireFreshOwnshipPosition(...args),
}));

let GuardianService: any;

let HAIL_MESSAGES: any;

let WEATHER_TEMPLATES: any;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAcquireFreshOwnshipPosition.mockResolvedValue({
        lat: -36.8485,
        lon: 174.7633,
        sog: 0,
        cog: 0,
        timestamp: Date.now(),
        source: 'gps',
    });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'test-user' } }, error: null });
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('test-user');
    const mod = await import('../services/GuardianService');
    GuardianService = mod.GuardianService;
    HAIL_MESSAGES = mod.HAIL_MESSAGES;
    WEATHER_TEMPLATES = mod.WEATHER_TEMPLATES;
});

afterEach(() => {
    GuardianService.stop();
});

describe('GuardianService — state management', () => {
    it('starts with empty state', () => {
        const state = GuardianService.getState();
        expect(state.profile).toBeNull();
        expect(state.nearbyUsers).toEqual([]);
        expect(state.alerts).toEqual([]);
        expect(state.armed).toBe(false);
        expect(state.nearbyCount).toBe(0);
        expect(state.loading).toBe(false);
    });

    it('notifies subscribers on state change', async () => {
        const listener = vi.fn();
        const unsub = GuardianService.subscribe(listener);

        // Simulate a state change via fetchProfile
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'test-user' } } });
        mockMaybeSingle.mockResolvedValueOnce({
            data: { user_id: 'test-user', armed: true, vessel_name: 'Test' },
            error: null,
        });

        await GuardianService.fetchProfile();
        expect(listener).toHaveBeenCalled();

        unsub();
        listener.mockClear();
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'test-user' } } });
        mockMaybeSingle.mockResolvedValueOnce({
            data: { user_id: 'test-user', armed: false, vessel_name: 'Test2' },
            error: null,
        });
        await GuardianService.fetchProfile();
        expect(listener).not.toHaveBeenCalled(); // Unsubscribed
    });

    it('does not acquire or transmit position while initialized disarmed', async () => {
        mockMaybeSingle.mockResolvedValue({
            data: { user_id: 'test-user', armed: false, vessel_name: 'Private Vessel' },
            error: null,
        });

        await GuardianService.initialize();

        expect(GuardianService.getState().armed).toBe(false);
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
        expect(mockRpc).not.toHaveBeenCalled();
    });

    it('heartbeats and polls only after restoring an armed profile', async () => {
        mockMaybeSingle.mockResolvedValue({
            data: { user_id: 'test-user', armed: true, vessel_name: 'Watch Vessel' },
            error: null,
        });
        mockRpc.mockResolvedValue({ data: [], error: null });

        await GuardianService.initialize();

        expect(mockAcquireFreshOwnshipPosition).toHaveBeenCalledOnce();
        expect(mockRpc).toHaveBeenCalledWith('guardian_heartbeat', {
            lat: -36.8485,
            lon: 174.7633,
        });
        expect(mockRpc).toHaveBeenCalledWith('nearby_guardians', { radius_nm: 5 });
        expect(mockRpc).toHaveBeenCalledWith('guardian_alerts_nearby', { radius_nm: 10, max_hours: 24 });
    });
});

describe('GuardianService — ARM / DISARM', () => {
    it('arm() calls guardian_arm RPC', async () => {
        mockRpc.mockResolvedValueOnce({ error: null }); // guardian_arm
        // fetchProfile after arm:
        mockGetUser.mockResolvedValue({ data: { user: { id: 'test-user' } } });
        mockMaybeSingle.mockResolvedValue({
            data: { user_id: 'test-user', armed: true, vessel_name: 'Test' },
            error: null,
        });
        // fetchNearbyUsers + fetchAlerts RPCs that may follow
        mockRpc.mockResolvedValue({ data: [], error: null });

        const result = await GuardianService.arm();
        expect(result).toBe(true);
        expect(mockRpc).toHaveBeenCalledWith('guardian_arm', {
            lat: -36.8485,
            lon: 174.7633,
        });
        expect(GuardianService.getState().armed).toBe(true);
    });

    it('disarm() calls guardian_disarm RPC', async () => {
        mockRpc.mockResolvedValueOnce({ error: null });
        mockGetUser.mockResolvedValue({ data: { user: { id: 'test-user' } } });
        mockMaybeSingle.mockResolvedValue({ data: null, error: null });

        const result = await GuardianService.disarm();
        expect(result).toBe(true);
        expect(mockRpc).toHaveBeenCalledWith('guardian_disarm');
        expect(GuardianService.getState().armed).toBe(false);
    });

    it('arm() fails gracefully on RPC error', async () => {
        mockRpc.mockResolvedValueOnce({ error: { message: 'DB Error' } });

        const result = await GuardianService.arm();
        expect(result).toBe(false);
    });
});

describe('GuardianService — Bay Presence', () => {
    it('fetchNearbyUsers() uses the server-held caller position and minimal nearby RPC', async () => {
        const mockUsers = [
            { user_id: 'u1', vessel_name: 'S/V Poodle', distance_nm: 0.5, last_known_at: new Date().toISOString() },
            { user_id: 'u2', vessel_name: 'S/V Biscuit', distance_nm: 1.2, last_known_at: new Date().toISOString() },
        ];
        mockMaybeSingle.mockResolvedValueOnce({
            data: { user_id: 'test-user', armed: true, vessel_name: 'Test' },
            error: null,
        });
        await GuardianService.fetchProfile();
        mockRpc.mockResolvedValueOnce({ data: mockUsers, error: null });

        const users = await GuardianService.fetchNearbyUsers();
        expect(users).toHaveLength(2);
        expect(users[0].vessel_name).toBe('S/V Poodle');
        expect(mockRpc).toHaveBeenCalledWith('nearby_guardians', { radius_nm: 5 });
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
        expect(GuardianService.getState().nearbyCount).toBe(2);
    });

    it('fetchNearbyUsers() returns empty on error', async () => {
        mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'test-user', armed: true }, error: null });
        await GuardianService.fetchProfile();
        mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'Network error' } });

        const users = await GuardianService.fetchNearbyUsers();
        expect(users).toEqual([]);
    });

    it('does not query nearby presence while disarmed', async () => {
        expect(await GuardianService.fetchNearbyUsers()).toEqual([]);
        expect(await GuardianService.refreshArmedPresence()).toBe(false);
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
    });

    it('refreshes an armed heartbeat before polling from the server-held fix', async () => {
        mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'test-user', armed: true }, error: null });
        await GuardianService.fetchProfile();
        mockRpc.mockResolvedValue({ data: [], error: null });
        const position = {
            lat: -36.8485,
            lon: 174.7633,
            sog: 0,
            cog: 0,
            timestamp: Date.now(),
            source: 'gps' as const,
        };

        expect(await GuardianService.refreshArmedPresence(position)).toBe(true);

        expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
            'guardian_heartbeat',
            'nearby_guardians',
            'guardian_alerts_nearby',
        ]);
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
    });
});

describe('GuardianService — Alert Feed', () => {
    it('fetchAlerts() calls guardian_alerts_nearby RPC', async () => {
        const mockAlerts = [
            {
                id: 'a1',
                alert_type: 'suspicious',
                title: 'Test',
                body: 'Test body',
                lat: -36.84,
                lon: 174.76,
                data: {},
                created_at: new Date().toISOString(),
            },
        ];
        mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'test-user', armed: true }, error: null });
        await GuardianService.fetchProfile();
        mockRpc.mockResolvedValueOnce({ data: mockAlerts, error: null });

        const alerts = await GuardianService.fetchAlerts();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].alert_type).toBe('suspicious');
        expect(mockRpc).toHaveBeenCalledWith(
            'guardian_alerts_nearby',
            expect.objectContaining({
                radius_nm: 10,
                max_hours: 24,
            }),
        );
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
    });
});

describe('GuardianService — Report Suspicious', () => {
    it('broadcasts alert via RPC', async () => {
        mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'test-user', armed: true }, error: null });
        await GuardianService.fetchProfile();
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'test-user' } } });
        mockRpc
            .mockResolvedValueOnce({ data: 3, error: null }) // broadcast
            .mockResolvedValueOnce({ data: [], error: null }); // fetchAlerts follow-up

        const result = await GuardianService.reportSuspicious('Unknown dinghy at 2 AM');
        expect(result.success).toBe(true);
        expect(result.notified).toBe(3);

        expect(mockRpc).toHaveBeenCalledWith(
            'broadcast_guardian_alert',
            expect.objectContaining({
                sender_user_id: 'test-user',
                p_alert_type: 'suspicious',
                radius_nm: 5,
            }),
        );
    });

    it('does not acquire or broadcast a location-based report while disarmed', async () => {
        expect(await GuardianService.reportSuspicious('Unknown dinghy at 2 AM')).toEqual({
            success: false,
            notified: 0,
        });
        expect(mockAcquireFreshOwnshipPosition).not.toHaveBeenCalled();
        expect(mockRpc).not.toHaveBeenCalled();
    });
});

describe('GuardianService — Constants', () => {
    it('has preset hail messages', () => {
        expect(HAIL_MESSAGES.length).toBeGreaterThanOrEqual(5);

        expect((HAIL_MESSAGES[0] as any).emoji).toBeDefined();

        expect((HAIL_MESSAGES[0] as any).text).toBeDefined();
    });

    it('has preset weather templates', () => {
        expect(WEATHER_TEMPLATES.length).toBeGreaterThanOrEqual(4);

        expect((WEATHER_TEMPLATES[0] as any).emoji).toBeDefined();

        expect((WEATHER_TEMPLATES[0] as any).text).toBeDefined();
    });
});
