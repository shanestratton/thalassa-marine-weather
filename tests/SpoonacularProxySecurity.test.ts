import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../services/supabase', () => ({
    supabase: {
        functions: { invoke },
    },
}));

import { fetchSpoonacular } from '../services/spoonacularProxy';

describe('Spoonacular paid-API boundary', () => {
    beforeEach(() => {
        invoke.mockReset();
    });

    it('keeps the paid credential and provider URL out of the browser service', () => {
        const source = readFileSync(resolve(process.cwd(), 'services/GalleyRecipeService.ts'), 'utf8');
        expect(source).toContain("fetchSpoonacular('");
        expect(source).not.toContain('VITE_SPOONACULAR_KEY');
        expect(source).not.toContain('api.spoonacular.com');
        expect(source).not.toMatch(/[?&]apiKey=/);
    });

    it('sends a small operation envelope through the Supabase function client', async () => {
        invoke.mockResolvedValueOnce({ data: { results: [] }, error: null });
        await expect(fetchSpoonacular('search', { query: 'fish curry', number: 5 })).resolves.toEqual({
            results: [],
        });
        expect(invoke).toHaveBeenCalledWith('proxy-spoonacular', {
            body: { operation: 'search', query: 'fish curry', number: 5 },
        });
    });

    it('fails closed on function errors or malformed empty responses', async () => {
        invoke.mockResolvedValueOnce({ data: null, error: { message: 'quota' } });
        await expect(fetchSpoonacular('bulk', { recipe_ids: [1] })).resolves.toBeNull();
        invoke.mockRejectedValueOnce(new Error('offline'));
        await expect(fetchSpoonacular('information', { recipe_id: 1 })).resolves.toBeNull();
    });

    it('uses a strict server operation allowlist, paid quota, timeout, and response cap', () => {
        const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/proxy-spoonacular/index.ts'), 'utf8');
        expect(edge).toContain("Deno.env.get('SPOONACULAR_API_KEY')");
        expect(edge).toContain('requireAuthenticatedOrPublicQuota(');
        expect(edge).toContain("operation === 'information'");
        expect(edge).toContain("operation === 'bulk'");
        expect(edge).toContain("operation === 'mealplan'");
        expect(edge).toContain("operation === 'search'");
        expect(edge).toContain('fetchWithTimeout(');
        expect(edge).toContain('readResponseTextLimited(upstream, 2_000_000)');
    });
});
