/**
 * Recipe references at the database boundary (126-B2a, binder audit GAL-02
 * and GAL-07; Shane 2026-10-09: "check all of the binders to make sure that
 * they are at the same standard as the rest of the app").
 *
 * A search result's numeric id is a display key. Only a real Spoonacular id,
 * a positive Postgres INTEGER, may reach `spoonacular_id`; a copy of another
 * sailor's recipe gets a deterministic RFC 9562 v8 id, so two phones copying
 * the same recipe write one row. Pure: no database, no network.
 * Fictional recipes and owners only.
 */
import { describe, expect, it } from 'vitest';
import {
    isPgInteger,
    isUuid,
    parseRecipeSteps,
    realSpoonacularId,
    recipeCopyId,
    uiKeyFromUuid,
} from '../services/galley/recipeRefs';

const FEIJOADA = '3f2b6c1e-8a4d-4e7f-9b21-5c6d7e8f9a0b';
const OYAKODON = '9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6';

describe('isPgInteger: what a Postgres INTEGER column takes', () => {
    it.each([1, 716429, 2147483647])('%s is one', (value) => {
        expect(isPgInteger(value)).toBe(true);
    });

    it.each([2147483648, 1791234567890, 1791234567890.42, 0, -1, Number.NaN, '123', null, undefined])(
        '%s is not',
        (value) => {
            expect(isPgInteger(value)).toBe(false);
        },
    );
});

describe('realSpoonacularId', () => {
    it('a search result: only a Spoonacular result with a real id', () => {
        expect(realSpoonacularId({ id: 716429, source: 'spoonacular' })).toBe(716429);
        // A community or private result carries a display key, never a provider id.
        expect(realSpoonacularId({ id: 716429, source: 'community' })).toBeNull();
        expect(realSpoonacularId({ id: 716429, source: 'private' })).toBeNull();
        expect(realSpoonacularId({ id: 716429 })).toBeNull();
        // The fake ids the old mappers made, even when labelled Spoonacular.
        expect(realSpoonacularId({ id: 1791234567890.42, source: 'spoonacular' })).toBeNull();
        expect(realSpoonacularId({ id: 1791234567890, source: 'spoonacular' })).toBeNull();
    });

    it('a stored row (recipe or meal plan): its column, when Postgres would take it', () => {
        expect(realSpoonacularId({ spoonacular_id: 716429 })).toBe(716429);
        expect(realSpoonacularId({ spoonacular_id: 1791234567890.42 })).toBeNull();
        expect(realSpoonacularId({ spoonacular_id: null })).toBeNull();
        expect(realSpoonacularId(null)).toBeNull();
    });
});

describe('isUuid', () => {
    it('takes any RFC 9562 layout and nothing else', () => {
        expect(isUuid(FEIJOADA)).toBe(true);
        expect(isUuid('E6705C1A-849D-8F06-9BA6-C338B772BB65')).toBe(true);
        expect(isUuid('recipe-1')).toBe(false);
        expect(isUuid('')).toBe(false);
        expect(isUuid(undefined)).toBe(false);
        expect(isUuid(716429)).toBe(false);
    });
});

describe('uiKeyFromUuid: a stable display key, never sent to the database', () => {
    it('is stable, a safe integer, and different for different recipes', () => {
        const key = uiKeyFromUuid(FEIJOADA);
        expect(uiKeyFromUuid(FEIJOADA)).toBe(key);
        expect(Number.isSafeInteger(key)).toBe(true);
        expect(uiKeyFromUuid(OYAKODON)).not.toBe(key);
    });

    it('can never pass for a Postgres INTEGER, so it cannot reach spoonacular_id', () => {
        expect(isPgInteger(uiKeyFromUuid(FEIJOADA))).toBe(false);
        expect(isPgInteger(uiKeyFromUuid('00000000-0000-4000-8000-000000000000'))).toBe(false);
        expect(isPgInteger(uiKeyFromUuid('not-a-uuid'))).toBe(false);
    });
});

describe('parseRecipeSteps: the stored directions, JSON or plain text', () => {
    it('a JSON RecipeStep[] round-trips', () => {
        const steps = [
            { number: 1, step: 'Rinse the corvina and cut it into cubes.' },
            { number: 2, step: 'Cover with lime juice for 20 minutes.' },
        ];
        expect(parseRecipeSteps(JSON.stringify(steps))).toEqual(steps);
    });

    it('plain text splits on new lines into numbered steps, blanks dropped', () => {
        expect(parseRecipeSteps('Soak beans.\r\n\r\nBrown pork.\nSimmer 2 h.')).toEqual([
            { number: 1, step: 'Soak beans.' },
            { number: 2, step: 'Brown pork.' },
            { number: 3, step: 'Simmer 2 h.' },
        ]);
    });

    it('nothing to cook from gives no steps', () => {
        expect(parseRecipeSteps('')).toEqual([]);
        expect(parseRecipeSteps('   ')).toEqual([]);
        expect(parseRecipeSteps('[]')).toEqual([]);
        expect(parseRecipeSteps(null)).toEqual([]);
        expect(parseRecipeSteps(undefined)).toEqual([]);
    });

    it('text that starts with "[" but is not JSON stays text', () => {
        expect(parseRecipeSteps('[Optional] Toast the bread.\nServe the Ψαρόσουπα hot.')).toEqual([
            { number: 1, step: '[Optional] Toast the bread.' },
            { number: 2, step: 'Serve the Ψαρόσουπα hot.' },
        ]);
    });
});

describe('recipeCopyId: one deterministic v8 id per owner and source recipe', () => {
    it('the same owner and recipe give the same id; another owner, another id', async () => {
        const a = await recipeCopyId('skipper-1', FEIJOADA);
        expect(await recipeCopyId('skipper-1', FEIJOADA)).toBe(a);
        expect(await recipeCopyId('crew-1', FEIJOADA)).not.toBe(a);
        expect(await recipeCopyId('skipper-1', OYAKODON)).not.toBe(a);
    });

    it('is an RFC 9562 version 8 id: version nibble 8, variant 8-b', async () => {
        const id = await recipeCopyId('skipper-1', FEIJOADA);
        expect(isUuid(id)).toBe(true);
        expect(id[14]).toBe('8');
        expect('89ab').toContain(id[19]);
    });

    it('matches the vectors computed by hand (SHA-256, the engine-hours byte layout)', async () => {
        // node: sha256('thalassa:recipes:copy:v1:<owner|anonymous>:<source>'), first 16 bytes,
        // byte 6 = (b & 0x0f) | 0x80, byte 8 = (b & 0x3f) | 0x80.
        expect(await recipeCopyId('skipper-1', FEIJOADA)).toBe('e6705c1a-849d-8f06-9ba6-c338b772bb65');
        expect(await recipeCopyId('crew-1', FEIJOADA)).toBe('42f157fd-5f6d-8300-9764-6fd9924185f3');
        expect(await recipeCopyId('', FEIJOADA)).toBe('48a869e2-eb81-8a40-a2bf-3c0a6b8e5602');
        expect(await recipeCopyId(null, FEIJOADA)).toBe('48a869e2-eb81-8a40-a2bf-3c0a6b8e5602');
    });
});
