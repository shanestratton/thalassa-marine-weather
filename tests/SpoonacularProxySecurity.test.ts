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

    it('keeps the paid provider disabled before any Supabase invocation', async () => {
        invoke.mockResolvedValueOnce({ data: { results: [] }, error: null });
        await expect(fetchSpoonacular('search', { query: 'fish curry', number: 5 })).resolves.toBeNull();
        expect(invoke).not.toHaveBeenCalled();
    });

    it('retains a fail-closed client boundary for any future activation', () => {
        const source = readFileSync(resolve(process.cwd(), 'services/spoonacularProxy.ts'), 'utf8');
        expect(source).toContain('!FEATURE_VISIBILITY.spoonacular || !supabase');
        expect(source).toContain('return error || data == null ? null : data');
        expect(source).toContain('catch');
    });

    it('uses a strict server operation allowlist, paid quota, timeout, and response cap', () => {
        const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/proxy-spoonacular/index.ts'), 'utf8');
        expect(edge).toContain("Deno.env.get('SPOONACULAR_ENABLED') !== 'true'");
        expect(edge).toContain("Deno.env.get('SPOONACULAR_API_KEY')");
        expect(edge.indexOf("Deno.env.get('SPOONACULAR_ENABLED')")).toBeLessThan(
            edge.indexOf("Deno.env.get('SPOONACULAR_API_KEY')"),
        );
        expect(edge).toContain('requireAuthenticatedOrPublicQuota(');
        expect(edge).toContain("operation === 'information'");
        expect(edge).toContain("operation === 'bulk'");
        expect(edge).toContain("operation === 'mealplan'");
        expect(edge).toContain("operation === 'search'");
        expect(edge).toContain('fetchWithTimeout(');
        expect(edge).toContain('readResponseTextLimited(upstream, 2_000_000)');
    });
});
