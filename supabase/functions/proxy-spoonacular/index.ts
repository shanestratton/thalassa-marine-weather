// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    jsonResponse,
    parseBoundedInteger,
    readJsonObject,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const API_BASE = 'https://api.spoonacular.com';
const SAFE_TEXT = /^[\p{L}\p{N}\s.,'()&+\-]+$/u;

function response(body: unknown, status = 200): Response {
    return jsonResponse(body, status, CORS);
}

function recipeId(value: unknown): number | null {
    return parseBoundedInteger(value, 1, 2_147_483_647);
}

function recipeIds(value: unknown): number[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
    const parsed = value.map(recipeId);
    if (parsed.some((id) => id === null)) return null;
    return [...new Set(parsed as number[])];
}

function boundedText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length >= 1 && normalized.length <= maxLength && SAFE_TEXT.test(normalized) ? normalized : null;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return response({ error: 'POST required' }, 405);
    if (Deno.env.get('SPOONACULAR_ENABLED') !== 'true') {
        return response({ error: 'Online recipe provider is disabled during beta' }, 503);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'spoonacular', 120, 20, 3600, true);
    if (caller instanceof Response) return withCors(caller, CORS);

    const key = Deno.env.get('SPOONACULAR_API_KEY');
    if (!key) return response({ error: 'Recipe provider is not configured' }, 503);

    const body = await readJsonObject(req, 4_096);
    const operation = typeof body?.operation === 'string' ? body.operation : '';
    const params = new URLSearchParams({ apiKey: key });
    let path = '';

    if (operation === 'information') {
        const id = recipeId(body?.recipe_id);
        if (id === null) return response({ error: 'Invalid recipe id' }, 400);
        path = `/recipes/${id}/information`;
        params.set('includeNutrition', 'false');
    } else if (operation === 'bulk') {
        const ids = recipeIds(body?.recipe_ids);
        if (!ids) return response({ error: 'Invalid recipe ids' }, 400);
        path = '/recipes/informationBulk';
        params.set('ids', ids.join(','));
        params.set('includeNutrition', 'false');
    } else if (operation === 'mealplan') {
        const calories = parseBoundedInteger(body?.target_calories ?? 3000, 1000, 5000);
        const exclude = boundedText(body?.exclude ?? 'soufflé,baked alaska', 120);
        if (calories === null || !exclude) return response({ error: 'Invalid meal-plan options' }, 400);
        path = '/mealplanner/generate';
        params.set('timeFrame', 'day');
        params.set('targetCalories', String(calories));
        params.set('exclude', exclude);
    } else if (operation === 'search') {
        const query = boundedText(body?.query, 100);
        const count = parseBoundedInteger(body?.number ?? 8, 1, 12);
        if (!query || count === null) return response({ error: 'Invalid recipe search' }, 400);
        path = '/recipes/complexSearch';
        params.set('query', query);
        params.set('number', String(count));
        params.set('addRecipeInformation', 'true');
        params.set('fillIngredients', 'true');
        params.set('instructionsRequired', 'false');
        params.set('sort', 'popularity');
    } else {
        return response({ error: 'Unsupported recipe operation' }, 400);
    }

    try {
        const upstream = await fetchWithTimeout(`${API_BASE}${path}?${params}`, {}, 12_000);
        const text = await readResponseTextLimited(upstream, 2_000_000);
        if (!upstream.ok || text === null) {
            console.error(`[proxy-spoonacular] upstream failed: ${upstream.status}`);
            return response({ error: 'Recipe provider unavailable' }, 502);
        }
        const data: unknown = JSON.parse(text);
        if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
            return response({ error: 'Recipe provider returned invalid data' }, 502);
        }
        return response(data);
    } catch (error) {
        console.error('[proxy-spoonacular] request failed:', error);
        return response({ error: 'Recipe provider unavailable' }, 502);
    }
});
