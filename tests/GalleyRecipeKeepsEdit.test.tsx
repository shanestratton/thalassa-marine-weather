/**
 * A recipe written in the Galley keeps its Edit button after a pull (126-B2a,
 * binder audit GAL-03; Shane 2026-10-09: "check all of the binders to make
 * sure that they are at the same standard as the rest of the app").
 *
 * createCustomRecipe used to upsert the row straight to the server without
 * `is_custom`. That landed before the outbox push, took the server default
 * (false), and the outbox INSERT was then ignored as a duplicate. The next
 * pull replaced the phone's row and the Edit button was gone on every device.
 * The direct upsert is gone (GalleyMealsReachServer.test.ts proves the push
 * carries is_custom); this pins what the page does with the pulled row.
 *
 * The real Galley page over the real LocalDatabase (Filesystem mocked) and
 * the real galley services; the socket, sync engine and passage lookup are
 * fakes. Fictional sailor 'skipper-<n>' of 'Kestrel'; recipes 'Tarte Tatin'
 * and 'Pão de queijo'.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({ user: { id: 'skipper-1' } }));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
}));
vi.mock('../services/PassagePlanService', () => ({
    getActivePassageId: () => null,
    getPassageStatus: vi.fn(),
    NO_PASSAGE_ACCESS: {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    },
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => null }));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../services/ProfilePhotoService', () => ({ compressImage: vi.fn() }));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: rt.user }),
}));
vi.mock('../hooks/usePermissions', () => ({ usePermissions: () => ({ loaded: true }) }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/passage/GalleyCookingMode', () => ({ GalleyCookingMode: () => null }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import type { StoredRecipe } from '../services/GalleyRecipeService';
import { GalleyPage } from '../components/vessel/GalleyPage';

const NOW = '2026-10-10T00:00:00.000Z';
let skipper = 'skipper-1';
let accountCounter = 0;

/** A recipes row as the server returns it on a pull. */
function serverRecipe(id: string, title: string, isCustom: boolean): StoredRecipe {
    return {
        id,
        spoonacular_id: null,
        user_id: skipper,
        title,
        image_url: '',
        ready_in_minutes: 70,
        servings: 6,
        source_url: '',
        instructions: 'Caramelise the sugar.\nAdd the apples.\nBake under pastry.',
        ingredients: [],
        is_favorite: false,
        is_custom: isCustom,
        visibility: 'personal',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
    };
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    accountCounter += 1;
    skipper = `skipper-${accountCounter}`;
    rt.user = { id: skipper };
    act(() => setAuthIdentityScope(skipper));
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({ version: 1, userId: skipper, confirmedAt: NOW, galleyLive: true, skippers: [] }),
    );
    reloadSharedBindersFromStorage();
    await initLocalDatabase(skipper);
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('a pulled Galley recipe keeps its Edit button', () => {
    it('is_custom from the server (the outbox INSERT) shows Edit; the old direct-upsert row did not', async () => {
        await mergePulledRecords('recipes', [
            serverRecipe('6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', 'Tarte Tatin', true),
            // What the direct upsert used to leave behind: is_custom false.
            serverRecipe('7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a', 'Pão de queijo', false),
        ]);

        render(<GalleyPage onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('tab', { name: /Saved recipes/ }));
        const panel = await screen.findByRole('tabpanel');

        expect(await within(panel).findByRole('button', { name: 'Edit Tarte Tatin' })).toBeInTheDocument();
        expect(within(panel).getByText('Pão de queijo')).toBeInTheDocument();
        expect(within(panel).queryByRole('button', { name: 'Edit Pão de queijo' })).not.toBeInTheDocument();
    });
});

describe('opening the Galley clears throwaway recipe photo copies once, at idle (GAL-12)', () => {
    it('the page schedules the purge on mount; it removes fake-keyed copies and keeps real ids', async () => {
        const idle: Array<() => void> = [];
        vi.stubGlobal('requestIdleCallback', (callback: () => void) => idle.push(callback));
        vi.stubGlobal('cancelIdleCallback', vi.fn());
        localStorage.setItem('thalassa_recipe_img_1791234567890.42', 'data:image/jpeg;base64,AAAA');
        localStorage.setItem('thalassa_recipe_img_716429', 'data:image/jpeg;base64,CCCC');

        try {
            render(<GalleyPage onBack={vi.fn()} />);
            await screen.findByRole('tab', { name: /Saved recipes/ });

            // Not during the first render: only when the main thread is idle.
            expect(idle).toHaveLength(1);
            expect(localStorage.getItem('thalassa_recipe_img_1791234567890.42')).not.toBeNull();

            act(() => idle.forEach((callback) => callback()));

            expect(localStorage.getItem('thalassa_recipe_img_1791234567890.42')).toBeNull();
            expect(localStorage.getItem('thalassa_recipe_img_716429')).toBe('data:image/jpeg;base64,CCCC');
            expect(localStorage.getItem('thalassa_recipe_img_purge_v1')).toBe('1');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
