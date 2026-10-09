/**
 * Deleting an account also deletes the sightings it logged on this phone:
 * the outbox records, their stripped photos and the crew feed cache
 * (services/sightings/sightingStore.ts purgeSightingsForUser). The server
 * rows go with the account by ON DELETE CASCADE and the photos by the storage
 * inventory (live since the seabed migration, 20261005130000). Fictional accounts only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    invoke: vi.fn(),
    signOut: vi.fn(),
    purgeSightings: vi.fn(),
    authState: {
        user: null as { id: string; email?: string } | null,
        authChecked: true,
    },
}));

vi.mock('../../services/supabase', () => ({
    supabase: {
        functions: { invoke: harness.invoke },
        auth: { signOut: harness.signOut },
    },
}));
vi.mock('../../services/accountDeletionPublicBetaBoundary', () => ({
    ACCOUNT_DELETION_PUBLIC_BETA_ENABLED: true,
    ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE: 'held for public beta',
}));
vi.mock('../../stores/authStore', () => ({
    useAuthStore: {
        getState: () => harness.authState,
        setState: (patch: Partial<typeof harness.authState>) => Object.assign(harness.authState, patch),
    },
}));
vi.mock('../../services/PushNotificationService', () => ({
    PushNotificationService: { clearUser: vi.fn(async () => undefined) },
}));
vi.mock('../../services/sentry', () => ({ setUser: vi.fn() }));
vi.mock('../../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: vi.fn(async () => undefined),
    purgeLocalDatabaseForUser: vi.fn(async () => []),
}));
// The Documents vault folder (126-B3a) is purged beside these; its own test is AccountDeletionService.
vi.mock('../../services/vessel/vaultFiles', () => ({ purgeVaultFilesForUser: vi.fn(async () => undefined) }));
vi.mock('../../services/nativeStorage', () => ({
    usesNativeEncryptedLargeStorage: () => false,
    DATA_CACHE_KEY: 'thalassa_weather_cache_v9',
    VOYAGE_CACHE_KEY: 'thalassa_voyage_cache_v2',
    HISTORY_CACHE_KEY: 'thalassa_history_cache_v3',
    deleteLargeData: vi.fn(async () => undefined),
}));
vi.mock('../../services/diaryPhotoStore', () => ({
    isIdbAudio: () => false,
    isIdbPhoto: () => false,
    deletePhoto: vi.fn(async () => undefined),
    deleteAudio: vi.fn(async () => undefined),
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        keys: vi.fn(async () => ({ keys: [] })),
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
    },
}));
vi.mock('../../services/sightings/sightingStore', () => ({
    purgeSightingsForUser: harness.purgeSightings,
}));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ISLA = { id: '6b0d7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', email: 'isla.marrow@example.invalid' };

beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.assign(harness.authState, { user: ISLA, authChecked: true });
    harness.invoke.mockResolvedValue({ data: { deleted: true, appleRevocationRequired: false }, error: null });
    harness.signOut.mockResolvedValue({ error: null });
    harness.purgeSightings.mockResolvedValue(3);
    const identity = await import('../../services/authIdentityScope');
    identity.setAuthIdentityScope(ISLA.id);
});

describe('account deletion reaches the sightings outbox', () => {
    it("purges the deleted account's sightings from this phone", async () => {
        const { deleteCurrentAccount } = await import('../../services/accountDeletion');
        await deleteCurrentAccount('DELETE');
        expect(harness.purgeSightings).toHaveBeenCalledWith(ISLA.id);
    });

    it('still finishes when the sightings purge fails, reporting the local cleanup as incomplete', async () => {
        harness.purgeSightings.mockRejectedValue(new Error('IndexedDB unavailable'));
        const { deleteCurrentAccount } = await import('../../services/accountDeletion');
        const result = await deleteCurrentAccount('DELETE');
        expect(harness.purgeSightings).toHaveBeenCalledWith(ISLA.id);
        expect(result).toMatchObject({ localCleanupComplete: false });
    });
});
