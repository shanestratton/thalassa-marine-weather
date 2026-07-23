import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';
import type { VoyageLogConfig } from '../services/VoyageLogService';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    authUserId: 'account-a',
    getUser: vi.fn(),
    from: vi.fn(),
    respond: vi.fn(),
    queries: [] as Array<{
        table: string;
        action: string;
        payload?: unknown;
        filters: Array<{ column: string; value: unknown }>;
    }>,
    getConfig: vi.fn(),
    ensureEnabled: vi.fn(),
    setEnabled: vi.fn(),
    getHiddenVoyageIds: vi.fn(),
    getPlanLinks: vi.fn(),
    setVoyageHidden: vi.fn(),
    setVoyagePlanLink: vi.fn(),
    getVoyageSummaries: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
    haptic: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    browserOpen: vi.fn(),
    clipboardWrite: vi.fn(),
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        getConfig: mocks.getConfig,
        ensureEnabled: mocks.ensureEnabled,
        setEnabled: mocks.setEnabled,
        getHiddenVoyageIds: mocks.getHiddenVoyageIds,
        getPlanLinks: mocks.getPlanLinks,
        setVoyageHidden: mocks.setVoyageHidden,
        setVoyagePlanLink: mocks.setVoyagePlanLink,
        lastError: null,
    },
    voyageLogPublicUrl: (handle: string) => `https://${handle}.thalassawx.app`,
    voyageLogApiUrl: (handle: string) => `https://api.example.test/voyage-log?handle=${handle}`,
}));

vi.mock('../services/supabase', () => {
    mocks.getUser.mockImplementation(async () => ({
        data: { user: mocks.authUserId ? { id: mocks.authUserId } : null },
        error: null,
    }));
    mocks.from.mockImplementation((table: string) => {
        const query: (typeof mocks.queries)[number] = {
            table,
            action: 'read',
            filters: [] as Array<{ column: string; value: unknown }>,
        };
        mocks.queries.push(query);
        const execute = () => Promise.resolve(mocks.respond(query));
        const builder: Record<string, unknown> = {};
        builder.select = vi.fn(() => builder);
        builder.insert = vi.fn((payload: unknown) => {
            query.action = 'insert';
            query.payload = payload;
            return builder;
        });
        builder.update = vi.fn((payload: unknown) => {
            query.action = 'update';
            query.payload = payload;
            return builder;
        });
        builder.eq = vi.fn((column: string, value: unknown) => {
            query.filters.push({ column, value });
            return builder;
        });
        builder.in = vi.fn((column: string, value: unknown) => {
            query.filters.push({ column, value });
            return builder;
        });
        builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            execute().then(resolve, reject);
        return builder;
    });
    return {
        supabase: {
            auth: { getUser: mocks.getUser },
            from: mocks.from,
        },
    };
});

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { getVoyageSummaries: mocks.getVoyageSummaries },
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: mocks.fetchRoutesAndTracks,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: mocks.haptic,
}));

vi.mock('../components/Toast', () => ({
    toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('@capacitor/browser', () => ({
    Browser: { open: mocks.browserOpen },
}));

import { VoyageLogTab } from '../components/settings/VoyageLogTab';

const settings = { liveTrackShare: false } as UserSettings;

function config(ownerId: string, boatId: string, enabled = true): VoyageLogConfig {
    return {
        id: `config-${ownerId}`,
        owner_id: ownerId,
        boat_id: boatId,
        handle: `${ownerId}-private-handle`,
        api_key: `${ownerId}-PRIVATE-API-KEY`,
        enabled,
        scope: 'combined',
        track_days: 30,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

function summary(voyageId: string, planned = false): VoyageSummary {
    return {
        voyageId,
        entryCount: 12,
        startedAt: '2026-07-22T00:00:00.000Z',
        endedAt: '2026-07-22T02:00:00.000Z',
        totalDistanceNM: 8,
        avgSpeedKts: 4,
        hasManual: false,
        isPlannedRoute: planned,
        isImported: false,
        firstLat: -27,
        firstLon: 153,
        lastLat: -27.1,
        lastLon: 153.1,
        firstIsOnWater: true,
        landFraction: 0,
    };
}

function route(id: string): RouteOrTrack {
    return {
        id,
        label: 'Plan A',
        sublabel: 'Brisbane to Noumea',
        points: [
            { lat: -27, lon: 153 },
            { lat: -22, lon: 166 },
        ],
        bbox: [153, -27, 166, -22],
        timestamp: Date.now(),
        distanceNm: 800,
        isLocal: false,
        kind: 'sea',
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function renderTab() {
    return render(<VoyageLogTab settings={settings} onSave={vi.fn()} />);
}

describe('VoyageLogTab identity transitions', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.authUserId = 'account-a';
        mocks.queries.length = 0;
        vi.clearAllMocks();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: mocks.clipboardWrite },
        });
        mocks.clipboardWrite.mockResolvedValue(undefined);
        mocks.getConfig.mockResolvedValue(config('account-a', 'boat-a'));
        mocks.ensureEnabled.mockResolvedValue(config('account-a', 'boat-a'));
        mocks.setEnabled.mockResolvedValue(config('account-a', 'boat-a'));
        mocks.getHiddenVoyageIds.mockResolvedValue(new Set());
        mocks.getPlanLinks.mockResolvedValue(new Map());
        mocks.setVoyageHidden.mockResolvedValue(true);
        mocks.setVoyagePlanLink.mockResolvedValue(true);
        mocks.getVoyageSummaries.mockResolvedValue([summary('voyage-a'), summary('plan-a', true)]);
        mocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [route('plan-a')], tracks: [] });
        mocks.respond.mockImplementation((query: (typeof mocks.queries)[number]) => {
            const userId = query.filters.find((filter) => filter.column === 'user_id')?.value;
            if (query.table === 'boat_members' && query.action === 'read') {
                return {
                    data:
                        userId === 'account-a'
                            ? [
                                  {
                                      boat_id: 'crew-boat-a',
                                      first_name: 'Ada',
                                      boats: { id: 'crew-boat-a', name: 'Crew Boat A', owner_id: 'captain-a' },
                                  },
                              ]
                            : [],
                    error: null,
                };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'read') {
                return {
                    data:
                        userId === 'account-a'
                            ? [{ boat_id: 'crew-boat-a', handle: 'ada-on-crew-a', enabled: true }]
                            : [],
                    error: null,
                };
            }
            return { data: null, error: null };
        });
    });

    it('synchronously hides A config, key, boats, tracks, picker, and copy state while B loads', async () => {
        const accountBConfig = deferred<VoyageLogConfig | null>();
        mocks.getConfig
            .mockResolvedValueOnce(config('account-a', 'boat-a'))
            .mockReturnValueOnce(accountBConfig.promise);

        renderTab();

        expect(await screen.findByText('https://account-a-private-handle.thalassawx.app')).toBeInTheDocument();
        expect(await screen.findByText('Crew Boat A')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Reveal API key' }));
        expect(screen.getByText('account-a-PRIVATE-API-KEY')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Copy API key' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Copy API key' })).toHaveTextContent('Copied'));
        fireEvent.click(screen.getByText(/Passage: none/));
        expect(screen.getByRole('button', { name: /Plan A/ })).toBeInTheDocument();

        act(() => {
            mocks.authUserId = 'account-b';
            setAuthIdentityScope('account-b');
        });

        expect(screen.queryByText('https://account-a-private-handle.thalassawx.app')).not.toBeInTheDocument();
        expect(screen.queryByText('account-a-PRIVATE-API-KEY')).not.toBeInTheDocument();
        expect(screen.queryByText('Crew Boat A')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Plan A/ })).not.toBeInTheDocument();
        expect(screen.queryByText('Copied')).not.toBeInTheDocument();

        await act(async () => accountBConfig.resolve(null));
        expect(await screen.findByRole('button', { name: 'Set up your voyage log' })).toBeInTheDocument();
    });

    it('discards a deferred A setup result without a B haptic or config flash', async () => {
        const accountASetup = deferred<VoyageLogConfig | null>();
        mocks.getConfig.mockResolvedValue(null);
        mocks.ensureEnabled.mockReturnValueOnce(accountASetup.promise);
        renderTab();
        fireEvent.click(await screen.findByRole('button', { name: 'Set up your voyage log' }));

        act(() => {
            mocks.authUserId = 'account-b';
            setAuthIdentityScope('account-b');
        });
        await act(async () => accountASetup.resolve(config('account-a', 'boat-a')));

        expect(await screen.findByRole('button', { name: 'Set up your voyage log' })).toBeInTheDocument();
        expect(screen.queryByText(/account-a-private-handle/)).not.toBeInTheDocument();
        expect(mocks.haptic).not.toHaveBeenCalledWith('medium');
    });

    it('does not retry or toast when an A crew-log insert resolves after B takes over', async () => {
        const accountAInsert = deferred<{ data: null; error: { code: string; message: string } }>();
        mocks.getConfig.mockResolvedValue(null);
        mocks.respond.mockImplementation((query: (typeof mocks.queries)[number]) => {
            const userId = query.filters.find((filter) => filter.column === 'user_id')?.value;
            if (query.table === 'boat_members') {
                return {
                    data:
                        userId === 'account-a'
                            ? [
                                  {
                                      boat_id: 'crew-boat-a',
                                      first_name: 'Ada',
                                      boats: { id: 'crew-boat-a', name: 'Crew Boat A', owner_id: 'captain-a' },
                                  },
                              ]
                            : [],
                    error: null,
                };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'read') {
                return { data: [], error: null };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'insert') {
                return accountAInsert.promise;
            }
            return { data: null, error: null };
        });

        renderTab();
        fireEvent.click(await screen.findByRole('button', { name: 'Create personal voyage log on Crew Boat A' }));
        await vi.waitFor(() =>
            expect(
                mocks.queries.some((query) => query.table === 'voyage_log_configs' && query.action === 'insert'),
            ).toBe(true),
        );
        const insert = mocks.queries.find(
            (query) => query.table === 'voyage_log_configs' && query.action === 'insert',
        )!;
        expect(insert.payload).toMatchObject({ owner_id: 'account-a', boat_id: 'crew-boat-a' });

        act(() => {
            mocks.authUserId = 'account-b';
            setAuthIdentityScope('account-b');
        });
        await act(async () =>
            accountAInsert.resolve({ data: null, error: { code: '23505', message: 'duplicate handle' } }),
        );

        expect(
            mocks.queries.filter((query) => query.table === 'voyage_log_configs' && query.action === 'insert'),
        ).toHaveLength(1);
        expect(mocks.toastError).not.toHaveBeenCalled();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.haptic).not.toHaveBeenCalledWith('medium');
    });

    it('does not run an A optimistic revert or error toast after switching to B', async () => {
        const accountAMutation = deferred<boolean>();
        mocks.setVoyageHidden.mockReturnValueOnce(accountAMutation.promise);
        mocks.getVoyageSummaries.mockResolvedValue([summary('voyage-a')]);
        mocks.getConfig.mockResolvedValueOnce(config('account-a', 'boat-a')).mockResolvedValueOnce(null);

        renderTab();
        const trackToggle = await screen.findByRole('switch', { name: /Show voyage/ });
        fireEvent.click(trackToggle);
        const hapticsAtSwitch = mocks.haptic.mock.calls.length;

        act(() => {
            mocks.authUserId = 'account-b';
            setAuthIdentityScope('account-b');
        });
        await act(async () => accountAMutation.resolve(false));

        expect(mocks.toastError).not.toHaveBeenCalled();
        expect(mocks.haptic).toHaveBeenCalledTimes(hapticsAtSwitch);
        expect(screen.queryByRole('switch', { name: /Show voyage/ })).not.toBeInTheDocument();
    });
});
