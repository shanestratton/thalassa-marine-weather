import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    invoke: vi.fn(),
    signOut: vi.fn(),
    clearPushUser: vi.fn(),
    setSentryUser: vi.fn(),
    initLocalDatabase: vi.fn(),
    purgeLocalDatabase: vi.fn(),
    deleteLargeData: vi.fn(),
    deletePhoto: vi.fn(),
    deleteAudio: vi.fn(),
    preferences: {} as Record<string, string>,
    authState: {
        user: null as { id: string; email?: string } | null,
        authChecked: true,
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        functions: { invoke: harness.invoke },
        auth: { signOut: harness.signOut },
    },
}));

// These tests exercise the retained deletion implementation itself. The
// production public-beta boundary has a separate fail-closed test and remains
// disabled in the committed release profile.
vi.mock('../services/accountDeletionPublicBetaBoundary', () => ({
    ACCOUNT_DELETION_PUBLIC_BETA_ENABLED: true,
    ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE: 'held for public beta',
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: {
        getState: () => harness.authState,
        setState: (patch: Partial<typeof harness.authState>) => Object.assign(harness.authState, patch),
    },
}));

vi.mock('../services/PushNotificationService', () => ({
    PushNotificationService: { clearUser: harness.clearPushUser },
}));

vi.mock('../services/sentry', () => ({ setUser: harness.setSentryUser }));

vi.mock('../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: harness.initLocalDatabase,
    purgeLocalDatabaseForUser: harness.purgeLocalDatabase,
}));

vi.mock('../services/nativeStorage', () => ({
    DATA_CACHE_KEY: 'thalassa_weather_cache_v9',
    VOYAGE_CACHE_KEY: 'thalassa_voyage_cache_v2',
    HISTORY_CACHE_KEY: 'thalassa_history_cache_v3',
    deleteLargeData: harness.deleteLargeData,
}));

vi.mock('../services/diaryPhotoStore', () => ({
    isIdbAudio: (reference: string) => reference.startsWith('idb-audio:'),
    isIdbPhoto: (reference: string) => reference.startsWith('idb:'),
    deletePhoto: harness.deletePhoto,
    deleteAudio: harness.deleteAudio,
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        keys: vi.fn(async () => ({ keys: Object.keys(harness.preferences) })),
        get: vi.fn(async ({ key }: { key: string }) => ({ value: harness.preferences[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.preferences[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete harness.preferences[key];
        }),
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const accountA = { id: 'account-a', email: 'a@example.com' };

beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    Object.assign(harness.authState, { user: accountA, authChecked: true });
    harness.invoke.mockResolvedValue({
        data: { deleted: true, appleRevocationRequired: false },
        error: null,
    });
    harness.signOut.mockResolvedValue({ error: null });
    harness.clearPushUser.mockResolvedValue(undefined);
    harness.initLocalDatabase.mockResolvedValue(undefined);
    harness.purgeLocalDatabase.mockResolvedValue([]);
    harness.deleteLargeData.mockResolvedValue(undefined);
    harness.deletePhoto.mockResolvedValue(undefined);
    harness.deleteAudio.mockResolvedValue(undefined);
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(accountA.id);
});

describe('deleteCurrentAccount', () => {
    it('requires the exact destructive confirmation before contacting the server', async () => {
        const { deleteCurrentAccount } = await import('../services/accountDeletion');

        await expect(deleteCurrentAccount('delete')).rejects.toThrow('Type DELETE');
        expect(harness.invoke).not.toHaveBeenCalled();
        expect(harness.authState.user).toEqual(accountA);
    });

    it('deletes remotely first, then purges the deleted identity, native caches, and global point weather caches', async () => {
        const suffix = `::${encodeURIComponent(`user:${accountA.id}`)}`;
        const otherSuffix = `::${encodeURIComponent('user:account-b')}`;
        const quarantineTime = new Date().toISOString();
        localStorage.setItem(`diary${suffix}`, JSON.stringify({ photos: ['idb:photo-a'] }));
        localStorage.setItem(`diary${otherSuffix}`, JSON.stringify({ photos: ['idb:photo-b'] }));
        localStorage.setItem(
            'thalassa_diary_entries_v2',
            JSON.stringify([
                { owner_user_id: accountA.id, photos: ['idb:legacy-photo-a'] },
                { owner_user_id: 'account-b', photos: ['idb:legacy-photo-b'] },
            ]),
        );
        localStorage.setItem(
            'thalassa_diary_quarantine_v1',
            JSON.stringify([
                { quarantined_at: quarantineTime, value: { owner_user_id: accountA.id, note: 'a' } },
                { quarantined_at: quarantineTime, value: { owner_user_id: 'account-b', note: 'b' } },
                { quarantined_at: '2020-01-01T00:00:00.000Z', value: 'expired' },
            ]),
        );
        localStorage.setItem('thalassa_doc_sync_status:account-a', JSON.stringify({ 'doc-a': { status: 'error' } }));
        localStorage.setItem('thalassa_doc_sync_status:account-b', JSON.stringify({ 'doc-b': { status: 'error' } }));
        localStorage.setItem('marine_weather_cache_v9_point_-27.47050_153.02600', 'point-cache');
        localStorage.setItem('marine_weather_cache_v8_brisbane', 'retired-point-cache');
        localStorage.setItem('last_marine_report', 'retired-last-report');
        localStorage.setItem('marine-weather-cache-unrelated', 'keep');
        sessionStorage.setItem(`draft${suffix}`, JSON.stringify({ audio_url: 'idb-audio:memo-a' }));
        sessionStorage.setItem('marine_weather_cache_v9_point_-17.73330_168.31670', 'session-point-cache');
        harness.preferences[`queue${suffix}`] = JSON.stringify({ photo: 'idb:photo-native' });
        harness.preferences[`queue${otherSuffix}`] = 'keep';
        harness.preferences['calypso:gmail:refresh_token'] = 'unowned-legacy-secret';
        harness.preferences.ship_log_offline_queue = JSON.stringify([
            { owner_user_id: accountA.id, _pendingPhotos: ['idb:shiplog-a'] },
            { owner_user_id: 'account-b', _pendingPhotos: ['idb:shiplog-b'] },
        ]);
        harness.preferences.ship_log_offline_queue_quarantine_v2 = JSON.stringify([
            { quarantined_at: quarantineTime, values: [{ owner_user_id: accountA.id, private: 'a' }] },
            { quarantined_at: quarantineTime, values: [{ owner_user_id: 'account-b', private: 'b' }] },
        ]);
        harness.purgeLocalDatabase.mockResolvedValue(['idb-audio:memo-db']);

        const { deleteCurrentAccount } = await import('../services/accountDeletion');
        const result = await deleteCurrentAccount('DELETE');

        expect(harness.invoke).toHaveBeenCalledWith('delete-account', { body: { confirmation: 'DELETE' } });
        expect(localStorage.getItem(`diary${suffix}`)).toBeNull();
        expect(localStorage.getItem(`diary${otherSuffix}`)).not.toBeNull();
        expect(JSON.parse(localStorage.getItem('thalassa_diary_entries_v2') ?? '[]')).toEqual([
            { owner_user_id: 'account-b', photos: ['idb:legacy-photo-b'] },
        ]);
        expect(localStorage.getItem('thalassa_diary_quarantine_v1')).toContain('"note":"b"');
        expect(localStorage.getItem('thalassa_diary_quarantine_v1')).not.toContain('"note":"a"');
        expect(localStorage.getItem('thalassa_diary_quarantine_v1')).not.toContain('expired');
        expect(localStorage.getItem('thalassa_doc_sync_status:account-a')).toBeNull();
        expect(localStorage.getItem('thalassa_doc_sync_status:account-b')).not.toBeNull();
        expect(localStorage.getItem('marine_weather_cache_v9_point_-27.47050_153.02600')).toBeNull();
        expect(localStorage.getItem('marine_weather_cache_v8_brisbane')).toBeNull();
        expect(localStorage.getItem('last_marine_report')).toBeNull();
        expect(localStorage.getItem('marine-weather-cache-unrelated')).toBe('keep');
        expect(sessionStorage.getItem('marine_weather_cache_v9_point_-17.73330_168.31670')).toBeNull();
        expect(harness.preferences[`queue${suffix}`]).toBeUndefined();
        expect(harness.preferences[`queue${otherSuffix}`]).toBe('keep');
        expect(harness.preferences['calypso:gmail:refresh_token']).toBeUndefined();
        expect(JSON.parse(harness.preferences.ship_log_offline_queue)).toEqual([
            { owner_user_id: 'account-b', _pendingPhotos: ['idb:shiplog-b'] },
        ]);
        expect(harness.preferences.ship_log_offline_queue_quarantine_v2).toContain('"private":"b"');
        expect(harness.preferences.ship_log_offline_queue_quarantine_v2).not.toContain('"private":"a"');
        expect(harness.purgeLocalDatabase).toHaveBeenCalledWith(accountA.id);
        expect(harness.deleteLargeData.mock.calls.map(([key]) => key)).toEqual([
            'thalassa_weather_cache_v9::user%3Aaccount-a',
            'thalassa_voyage_cache_v2::user%3Aaccount-a',
            'thalassa_history_cache_v3::user%3Aaccount-a',
            'thalassa_next_update::user%3Aaccount-a',
            'thalassa_weather_cache_schema::user%3Aaccount-a',
        ]);
        expect(harness.deletePhoto).toHaveBeenCalledWith('idb:photo-a');
        expect(harness.deletePhoto).toHaveBeenCalledWith('idb:photo-native');
        expect(harness.deletePhoto).toHaveBeenCalledWith('idb:legacy-photo-a');
        expect(harness.deletePhoto).toHaveBeenCalledWith('idb:shiplog-a');
        expect(harness.deletePhoto).not.toHaveBeenCalledWith('idb:legacy-photo-b');
        expect(harness.deletePhoto).not.toHaveBeenCalledWith('idb:shiplog-b');
        expect(harness.deleteAudio).toHaveBeenCalledWith('idb-audio:memo-a');
        expect(harness.deleteAudio).toHaveBeenCalledWith('idb-audio:memo-db');
        expect(harness.clearPushUser).toHaveBeenCalledOnce();
        expect(harness.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(harness.authState.user).toBeNull();
        expect(result).toEqual({ deleted: true, localCleanupComplete: true, appleRevocationRequired: false });
    });

    it('blocks remote deletion while MOB or Anchor Watch recovery is active', async () => {
        const suffix = `::${encodeURIComponent(`user:${accountA.id}`)}`;
        localStorage.setItem(`thalassa_anchor_watch_state${suffix}`, 'active-anchor');
        harness.preferences[`thalassa_mob_active_v1${suffix}`] = 'active-mob';
        const { deleteCurrentAccount } = await import('../services/accountDeletion');

        await expect(deleteCurrentAccount('DELETE')).rejects.toThrow('Man Overboard and Anchor Watch are active');

        expect(harness.invoke).not.toHaveBeenCalled();
        expect(harness.signOut).not.toHaveBeenCalled();
        expect(harness.clearPushUser).not.toHaveBeenCalled();
        expect(harness.authState.user).toEqual(accountA);
        expect(localStorage.getItem(`thalassa_anchor_watch_state${suffix}`)).toBe('active-anchor');
        expect(harness.preferences[`thalassa_mob_active_v1${suffix}`]).toBe('active-mob');
    });

    it('leaves the live account and local data untouched when remote deletion fails', async () => {
        const suffix = `::${encodeURIComponent(`user:${accountA.id}`)}`;
        localStorage.setItem(`diary${suffix}`, 'private');
        harness.invoke.mockResolvedValue({ data: null, error: new Error('offline') });
        const { deleteCurrentAccount } = await import('../services/accountDeletion');

        await expect(deleteCurrentAccount('DELETE')).rejects.toThrow('could not be confirmed complete');

        expect(localStorage.getItem(`diary${suffix}`)).toBe('private');
        expect(harness.purgeLocalDatabase).not.toHaveBeenCalled();
        expect(harness.clearPushUser).not.toHaveBeenCalled();
        expect(harness.authState.user).toEqual(accountA);
    });

    it('reports durable partial progress without signing out or erasing local recovery data', async () => {
        const suffix = `::${encodeURIComponent(`user:${accountA.id}`)}`;
        localStorage.setItem(`diary${suffix}`, 'private-local-recovery');
        harness.invoke.mockResolvedValue({
            data: {
                deleted: false,
                deletionInProgress: true,
                phase: 'storage_cleanup',
                message: 'Account deletion has started and is write-fenced. Retry to continue safely.',
            },
            error: null,
        });
        const { deleteCurrentAccount } = await import('../services/accountDeletion');

        await expect(deleteCurrentAccount('DELETE')).rejects.toThrow('has started and is write-fenced');

        expect(localStorage.getItem(`diary${suffix}`)).toBe('private-local-recovery');
        expect(harness.purgeLocalDatabase).not.toHaveBeenCalled();
        expect(harness.signOut).not.toHaveBeenCalled();
        expect(harness.authState.user).toEqual(accountA);
    });

    it('uses the server revocation result to flag a legacy Apple account for manual consent removal', async () => {
        harness.authState.user = {
            ...accountA,
            app_metadata: { provider: 'apple' },
        } as typeof harness.authState.user;
        harness.invoke.mockResolvedValue({
            data: { deleted: true, appleRevocationRequired: true },
            error: null,
        });
        const { deleteCurrentAccount } = await import('../services/accountDeletion');

        await expect(deleteCurrentAccount('DELETE')).resolves.toEqual({
            deleted: true,
            localCleanupComplete: true,
            appleRevocationRequired: true,
        });
    });

    it('does not sign out or wipe a newer account when identity changes during the request', async () => {
        let resolveInvoke!: (value: { data: { deleted: true; appleRevocationRequired: false }; error: null }) => void;
        harness.invoke.mockReturnValue(
            new Promise((resolve) => {
                resolveInvoke = resolve;
            }),
        );
        const { deleteCurrentAccount } = await import('../services/accountDeletion');
        const identity = await import('../services/authIdentityScope');

        const deleting = deleteCurrentAccount('DELETE');
        identity.setAuthIdentityScope('account-b');
        harness.authState.user = { id: 'account-b', email: 'b@example.com' };
        resolveInvoke({ data: { deleted: true, appleRevocationRequired: false }, error: null });
        await deleting;

        expect(harness.initLocalDatabase).toHaveBeenCalledWith('account-b');
        expect(harness.purgeLocalDatabase).toHaveBeenCalledWith(accountA.id);
        expect(harness.clearPushUser).not.toHaveBeenCalled();
        expect(harness.signOut).not.toHaveBeenCalled();
        expect(harness.authState.user?.id).toBe('account-b');
        expect(identity.getAuthIdentityScope().userId).toBe('account-b');
    });
});
