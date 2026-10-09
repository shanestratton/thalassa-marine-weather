/**
 * No throwaway photo copies in localStorage (126-B2a, binder audit GAL-12;
 * Shane 2026-10-09: "check all of the binders to make sure that they are at
 * the same standard as the rest of the app").
 *
 * Every scheduling of a searched recipe used to cache its photo as a base64
 * data URI under the search result's fake id ('thalassa_recipe_img_' +
 * 1791234567890.42), with no cap and no reader: ChefPlate only reads real
 * Spoonacular ids. Now only a real Spoonacular id is cached, and a one-off
 * purge removes the fake-keyed copies already on the phone.
 *
 * The real MealPlanService and GalleyRecipeService over the real
 * LocalDatabase (the global filesystem mock); fetch is stubbed with a tiny
 * image so a cache write would really happen. Fictional recipes only.
 */
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { initLocalDatabase } from '../services/vessel/LocalDatabase';
import { scheduleMeal } from '../services/MealPlanService';
import type { GalleyMeal } from '../services/GalleyRecipeService';
import { purgeOrphanRecipeImages, purgeOrphanRecipeImagesWhenIdle } from '../services/galley/recipeImagePurge';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const PREFIX = 'thalassa_recipe_img_';
const CEVICHE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
let phone = 0;

const imageKeys = () => Object.keys(localStorage).filter((key) => key.startsWith(PREFIX));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function result(overrides: Partial<GalleyMeal>): GalleyMeal {
    return {
        id: Date.now() + Math.random(),
        title: 'Ceviche de corvina',
        readyInMinutes: 30,
        servings: 2,
        image: 'https://images.example.test/recipes/ceviche.jpg',
        sourceUrl: '',
        ingredients: [],
        instructions: [{ number: 1, step: 'Cure the corvina in lime.' }],
        source: 'community',
        supabaseId: CEVICHE,
        ...overrides,
    };
}

beforeEach(async () => {
    phone += 1;
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Blob(['tiny-image'], { type: 'image/jpeg' }), { status: 200 })),
    );
    setAuthIdentityScope(`cook-${phone}`);
    await initLocalDatabase(`cook-${phone}`);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (FEATURE_VISIBILITY as { spoonacular: boolean }).spoonacular = false;
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('scheduling caches a photo only for a real Spoonacular id', () => {
    it('a community recipe with a photo writes no thalassa_recipe_img_ key', async () => {
        await scheduleMeal(result({}), '2026-10-12', 'lunch', null, 2, `cook-${phone}`);
        await settle();

        expect(imageKeys()).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('a real Spoonacular recipe (716429, provider on) still caches under its own id', async () => {
        (FEATURE_VISIBILITY as { spoonacular: boolean }).spoonacular = true;

        await scheduleMeal(
            result({
                id: 716429,
                source: 'spoonacular',
                supabaseId: undefined,
                image: 'https://img.spoonacular.com/recipes/716429-480x360.jpg',
            }),
            '2026-10-12',
            'dinner',
            null,
            2,
            `cook-${phone}`,
        );

        await vi.waitFor(() => expect(imageKeys()).toEqual([`${PREFIX}716429`]));
        // A data URI (jsdom's Response does not carry the Blob's image type).
        expect(localStorage.getItem(`${PREFIX}716429`)).toMatch(/^data:[^,]*;base64,/);
    });
});

describe('purgeOrphanRecipeImages', () => {
    it('removes the fake-keyed copies, keeps real ids and everything else, and runs once', () => {
        localStorage.setItem(`${PREFIX}1791234567890.42`, 'data:image/jpeg;base64,AAAA');
        localStorage.setItem(`${PREFIX}1791234567890`, 'data:image/jpeg;base64,BBBB');
        localStorage.setItem(`${PREFIX}716429`, 'data:image/jpeg;base64,CCCC');
        localStorage.setItem('thalassa_galley_favourites', '[]');

        expect(purgeOrphanRecipeImages()).toBe(2);

        expect(localStorage.getItem(`${PREFIX}1791234567890.42`)).toBeNull();
        expect(localStorage.getItem(`${PREFIX}1791234567890`)).toBeNull();
        expect(localStorage.getItem(`${PREFIX}716429`)).toBe('data:image/jpeg;base64,CCCC');
        expect(localStorage.getItem('thalassa_galley_favourites')).toBe('[]');

        // Once per install: a later fake key is not swept again.
        localStorage.setItem(`${PREFIX}1791234567999.5`, 'data:image/jpeg;base64,DDDD');
        expect(purgeOrphanRecipeImages()).toBe(0);
        expect(localStorage.getItem(`${PREFIX}1791234567999.5`)).not.toBeNull();
    });

    it('a throwing localStorage never throws out', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        expect(() => purgeOrphanRecipeImages()).not.toThrow();
        expect(purgeOrphanRecipeImages()).toBe(0);
    });
});

describe('purgeOrphanRecipeImagesWhenIdle (WKWebView has no requestIdleCallback)', () => {
    it('falls back to a 2 s timer, and the effect cleanup cancels it', () => {
        vi.useFakeTimers();
        try {
            expect('requestIdleCallback' in globalThis).toBe(false);
            localStorage.setItem(`${PREFIX}1791234567890.42`, 'data:image/jpeg;base64,AAAA');

            const cancel = purgeOrphanRecipeImagesWhenIdle();
            cancel();
            vi.advanceTimersByTime(2_000);
            expect(localStorage.getItem(`${PREFIX}1791234567890.42`)).not.toBeNull();

            purgeOrphanRecipeImagesWhenIdle();
            vi.advanceTimersByTime(1_999);
            expect(localStorage.getItem(`${PREFIX}1791234567890.42`)).not.toBeNull();
            vi.advanceTimersByTime(1);
            expect(localStorage.getItem(`${PREFIX}1791234567890.42`)).toBeNull();
            expect(localStorage.getItem('thalassa_recipe_img_purge_v1')).toBe('1');
        } finally {
            vi.useRealTimers();
        }
    });
});
