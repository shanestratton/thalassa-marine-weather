/**
 * GalleyRecipeService — Spoonacular API wrapper + offline recipe persistence.
 *
 * Phase 3 upgrade:
 *  - Persists recipes to LocalDatabase for offline use at sea
 *  - Ingredient scaler with scalable/non-scalable detection
 *  - Shopping list generation with crew scaling
 *  - Ready-in-minutes prominently tracked for galley timing
 */

import { getAll, insertLocal, query, generateUUID } from './vessel/LocalDatabase';

const API_BASE = 'https://api.spoonacular.com';
const CACHE_PREFIX = 'thalassa_galley_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Types ──────────────────────────────────────────────────────────────────

export interface RecipeIngredient {
    name: string;
    amount: number;
    unit: string;
    scalable: boolean;
    aisle: string;
}

export interface StoredRecipe {
    id: string;
    spoonacular_id: number | null;
    title: string;
    image_url: string;
    ready_in_minutes: number;
    servings: number; // BASE servings (what the recipe is written for)
    source_url: string;
    ingredients: RecipeIngredient[];
    is_favorite: boolean;
    tags: string[];
    created_at: string;
    updated_at: string;
}

export interface GalleyMeal {
    id: number;
    title: string;
    readyInMinutes: number;
    servings: number;
    image: string;
    sourceUrl: string;
    ingredients: RecipeIngredient[];
}

export interface GalleyDayPlan {
    day: number;
    meals: GalleyMeal[]; // [breakfast, lunch, dinner]
    nutrients: {
        calories: number;
        protein: number;
        fat: number;
        carbohydrates: number;
    };
}

export interface GalleyPlan {
    days: GalleyDayPlan[];
    generatedAt: number;
}

export interface ShoppingItem {
    name: string;
    amount: number;
    unit: string;
    aisle: string;
    scalable: boolean;
}

// ── Scalable/Non-Scalable Detection ────────────────────────────────────────

/** Units that indicate a non-scalable ingredient (whole containers) */
const NON_SCALABLE_UNITS = new Set([
    'bottle',
    'bottles',
    'jar',
    'jars',
    'can',
    'cans',
    'packet',
    'packets',
    'tube',
    'tubes',
    'pinch',
    'pinches',
    'dash',
    'dashes',
    'splash',
    'drop',
    'drops',
]);

/** Detect whether an ingredient should scale with crew size */
export function isScalable(unit: string, name: string): boolean {
    const u = (unit || '').toLowerCase().trim();
    const n = (name || '').toLowerCase();

    // Non-scalable by unit
    if (NON_SCALABLE_UNITS.has(u)) return false;

    // Non-scalable by name pattern (condiments, seasonings)
    if (/hot sauce|sriracha|worcester|tabasco|vanilla extract|baking soda|baking powder/i.test(n)) {
        return false;
    }

    // Everything else scales (kg, g, L, ml, cup, whole, lb, oz, etc.)
    return true;
}

/**
 * Scale an ingredient for a given crew size.
 *
 * @param amount     - Base amount from the recipe
 * @param scalable   - Whether this ingredient scales with crew
 * @param recipeServings - What the recipe is written for (e.g., 4)
 * @param crewCount  - Actual crew size (e.g., 6)
 * @returns Scaled amount (rounded up to 1 decimal)
 */
export function scaleIngredient(amount: number, scalable: boolean, recipeServings: number, crewCount: number): number {
    if (!scalable) return amount; // 1 bottle stays 1 bottle
    const ratio = crewCount / Math.max(recipeServings, 1);
    return Math.ceil(amount * ratio * 10) / 10; // Round up to 0.1
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getApiKey(): string {
    return (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (import.meta as any).env?.VITE_SPOONACULAR_KEY || ''
    );
}

function cacheKey(days: number, crew: number): string {
    return `${CACHE_PREFIX}plan_${days}_${crew}`;
}

function getCached(key: string): GalleyPlan | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as GalleyPlan;
        if (Date.now() - parsed.generatedAt > CACHE_TTL_MS) {
            localStorage.removeItem(key);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function setCache(key: string, plan: GalleyPlan): void {
    try {
        localStorage.setItem(key, JSON.stringify(plan));
    } catch {
        /* Storage full */
    }
}

// ── Recipe Persistence ─────────────────────────────────────────────────────

const RECIPE_TABLE = 'recipes';
const IMG_CACHE_PREFIX = 'thalassa_recipe_img_';

// ── Image Caching ──────────────────────────────────────────────────────────

/**
 * Cache a recipe image as a base64 data URI in localStorage.
 * Returns the data URI on success, or the original URL on failure.
 */
export async function cacheRecipeImage(imageUrl: string, recipeId: number): Promise<string> {
    if (!imageUrl) return imageUrl;

    // Already cached?
    const cached = getCachedImage(recipeId);
    if (cached) return cached;

    try {
        const resp = await fetch(imageUrl);
        if (!resp.ok) return imageUrl;
        const blob = await resp.blob();

        return new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUri = reader.result as string;
                try {
                    localStorage.setItem(`${IMG_CACHE_PREFIX}${recipeId}`, dataUri);
                } catch {
                    /* localStorage full — still return the data URI for this session */
                }
                resolve(dataUri);
            };
            reader.onerror = () => resolve(imageUrl);
            reader.readAsDataURL(blob);
        });
    } catch {
        return imageUrl; // Network error — use original URL
    }
}

/** Get a cached recipe image (synchronous). Returns null if not cached. */
export function getCachedImage(recipeId: number): string | null {
    try {
        return localStorage.getItem(`${IMG_CACHE_PREFIX}${recipeId}`) || null;
    } catch {
        return null;
    }
}

/**
 * Get the best available image URL for a recipe (cache-first).
 * Returns cached base64 data URI if available, else the network URL.
 */
export function getRecipeImageUrl(spoonacularId: number | null, fallbackUrl: string): string {
    if (spoonacularId) {
        const cached = getCachedImage(spoonacularId);
        if (cached) return cached;
    }
    return fallbackUrl || `https://img.spoonacular.com/recipes/${spoonacularId}-480x360.jpg`;
}

/**
 * Persist a Spoonacular recipe into LocalDatabase for offline access.
 * Also caches the recipe image for offline rendering.
 */
export async function persistRecipe(meal: GalleyMeal): Promise<StoredRecipe> {
    // Check if already stored
    const existing = query<StoredRecipe>(RECIPE_TABLE, (r) => r.spoonacular_id === meal.id);
    if (existing.length > 0) return existing[0];

    const now = new Date().toISOString();
    const record: StoredRecipe = {
        id: generateUUID(),
        spoonacular_id: meal.id,
        title: meal.title,
        image_url: meal.image,
        ready_in_minutes: meal.readyInMinutes,
        servings: meal.servings,
        source_url: meal.sourceUrl,
        ingredients: meal.ingredients || [],
        is_favorite: false,
        tags: [],
        created_at: now,
        updated_at: now,
    };

    await insertLocal(RECIPE_TABLE, record);

    // Fire-and-forget: cache the recipe image for offline use
    if (meal.image && meal.id) {
        cacheRecipeImage(meal.image, meal.id).catch(() => {
            /* non-critical */
        });
    }

    return record;
}

/** Get all locally stored recipes */
export function getStoredRecipes(): StoredRecipe[] {
    return getAll<StoredRecipe>(RECIPE_TABLE);
}

/** Get favorite recipes */
export function getFavoriteRecipes(): StoredRecipe[] {
    return query<StoredRecipe>(RECIPE_TABLE, (r) => r.is_favorite);
}

// ── Parse Spoonacular Ingredients ──────────────────────────────────────────

/**
 * Parse Spoonacular's extendedIngredients into our RecipeIngredient format
 * with auto-detected scalable flag.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseIngredients(extendedIngredients: any[]): RecipeIngredient[] {
    if (!extendedIngredients) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extendedIngredients.map((ing: any) => ({
        name: ing.name || ing.originalName || '',
        amount: ing.amount || 0,
        unit: ing.unit || '',
        scalable: isScalable(ing.unit || '', ing.name || ''),
        aisle: ing.aisle || 'Other',
    }));
}

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Generate a galley-friendly meal plan for a passage.
 * Now fetches ingredient details and persists recipes locally.
 */
export async function generateGalleyPlan(days: number, crew: number): Promise<GalleyPlan | null> {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    // Check cache first
    const cached = getCached(cacheKey(days, crew));
    if (cached) return cached;

    try {
        const dayPlans: GalleyDayPlan[] = [];
        const uniqueDays = Math.min(days, 7);

        for (let i = 0; i < uniqueDays; i++) {
            const params = new URLSearchParams({
                apiKey,
                timeFrame: 'day',
                targetCalories: '3000',
                diet: '',
                exclude: 'soufflé,baked alaska',
            });

            const resp = await fetch(`${API_BASE}/mealplanner/generate?${params}`);
            if (!resp.ok) {
                console.warn(`[GalleyRecipe] API error: ${resp.status}`);
                return null;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = (await resp.json()) as any;

            // Fetch full recipe details for ingredients
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mealIds = (data.meals || []).slice(0, 3).map((m: any) => m.id);
            const recipeDetails: Record<number, RecipeIngredient[]> = {};

            if (mealIds.length > 0) {
                try {
                    const detailResp = await fetch(
                        `${API_BASE}/recipes/informationBulk?apiKey=${apiKey}&ids=${mealIds.join(',')}&includeNutrition=false`,
                    );
                    if (detailResp.ok) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const details = (await detailResp.json()) as any[];
                        for (const detail of details) {
                            recipeDetails[detail.id] = parseIngredients(detail.extendedIngredients);
                        }
                    }
                } catch {
                    // Ingredient fetch failed — proceed without ingredients
                }
            }

            const meals: GalleyMeal[] = (data.meals || []).slice(0, 3).map(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (m: any) => ({
                    id: m.id,
                    title: m.title,
                    readyInMinutes: m.readyInMinutes || 30,
                    servings: m.servings || 2,
                    image: m.image
                        ? m.image.startsWith('http')
                            ? m.image
                            : `https://img.spoonacular.com/recipes/${m.id}-480x360.jpg`
                        : `https://img.spoonacular.com/recipes/${m.id}-480x360.jpg`,
                    sourceUrl: m.sourceUrl || '',
                    ingredients: recipeDetails[m.id] || [],
                }),
            );

            // Persist each recipe locally for offline access
            for (const meal of meals) {
                try {
                    await persistRecipe(meal);
                } catch {
                    /* non-critical */
                }
            }

            dayPlans.push({
                day: i + 1,
                meals,
                nutrients: {
                    calories: Math.round(data.nutrients?.calories || 3000),
                    protein: Math.round(data.nutrients?.protein || 100),
                    fat: Math.round(data.nutrients?.fat || 100),
                    carbohydrates: Math.round(data.nutrients?.carbohydrates || 300),
                },
            });

            if (i < uniqueDays - 1) {
                await new Promise((r) => setTimeout(r, 250));
            }
        }

        // If passage > 7 days, cycle the plan
        const allDays: GalleyDayPlan[] = [];
        for (let d = 0; d < days; d++) {
            const src = dayPlans[d % dayPlans.length];
            allDays.push({ ...src, day: d + 1 });
        }

        const plan: GalleyPlan = {
            days: allDays,
            generatedAt: Date.now(),
        };

        setCache(cacheKey(days, crew), plan);
        return plan;
    } catch (err) {
        console.warn('[GalleyRecipe] Failed to generate plan:', err);
        return null;
    }
}

/**
 * Generate a consolidated shopping list from a meal plan.
 * Uses ingredient data from persisted recipes with crew scaling.
 */
export async function getShoppingList(recipeIds: number[]): Promise<ShoppingItem[]> {
    const apiKey = getApiKey();
    if (!apiKey || recipeIds.length === 0) return [];

    // Check cache
    const listKey = `${CACHE_PREFIX}shop_${recipeIds.sort().join(',')}`;
    try {
        const raw = localStorage.getItem(listKey);
        if (raw) return JSON.parse(raw) as ShoppingItem[];
    } catch {
        /* ignore */
    }

    try {
        const ids = recipeIds.join(',');
        const resp = await fetch(
            `${API_BASE}/recipes/informationBulk?apiKey=${apiKey}&ids=${ids}&includeNutrition=false`,
        );
        if (!resp.ok) return [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recipes = (await resp.json()) as any[];

        const ingredientMap = new Map<string, ShoppingItem>();

        for (const recipe of recipes) {
            for (const ing of recipe.extendedIngredients || []) {
                const key = ing.name?.toLowerCase() || '';
                if (!key) continue;
                const scalableFlag = isScalable(ing.unit || '', key);
                const existing = ingredientMap.get(key);
                if (existing) {
                    existing.amount += ing.amount || 0;
                } else {
                    ingredientMap.set(key, {
                        name: ing.name || '',
                        amount: ing.amount || 0,
                        unit: ing.unit || '',
                        aisle: ing.aisle || 'Other',
                        scalable: scalableFlag,
                    });
                }
            }
        }

        const list = Array.from(ingredientMap.values()).sort(
            (a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name),
        );

        try {
            localStorage.setItem(listKey, JSON.stringify(list));
        } catch {
            /* ignore */
        }

        return list;
    } catch (err) {
        console.warn('[GalleyRecipe] Failed to get shopping list:', err);
        return [];
    }
}

// ── Recipe Search (Per-Slot) ───────────────────────────────────────────────

const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Search for recipes by query string using Spoonacular complexSearch.
 * Used by the meal calendar's per-slot picker. Results are cached 24hr.
 *
 * @param searchQuery  - e.g. "chicken curry", "pasta", "breakfast eggs"
 * @param mealType     - Optional: "breakfast" | "lunch" | "dinner" | "snack"
 * @param maxResults   - Max results to return (default 8)
 */
export async function searchRecipes(
    searchQuery: string,
    mealType?: string,
    maxResults = 8,
): Promise<GalleyMeal[]> {
    const apiKey = getApiKey();
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return [];

    // Cache key for this specific search
    const cacheKey = `${CACHE_PREFIX}search_${trimmed}_${mealType || 'any'}`;
    try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
            const cached = JSON.parse(raw) as { results: GalleyMeal[]; ts: number };
            if (Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) return cached.results;
            localStorage.removeItem(cacheKey);
        }
    } catch {
        /* ignore */
    }

    // No API key — fall back to locally stored recipes matching the query
    if (!apiKey) {
        console.warn('[GalleyRecipe] No API key found — falling back to local recipes');
        const stored = getStoredRecipes();
        return stored
            .filter((r) => r.title.toLowerCase().includes(trimmed))
            .slice(0, maxResults)
            .map((r) => ({
                id: r.spoonacular_id ?? Date.now(),
                title: r.title,
                readyInMinutes: r.ready_in_minutes,
                servings: r.servings,
                image: r.image_url,
                sourceUrl: r.source_url,
                ingredients: r.ingredients,
            }));
    }

    try {
        const params = new URLSearchParams({
            apiKey,
            query: trimmed,
            number: String(maxResults),
            addRecipeInformation: 'true',
            fillIngredients: 'true',
            instructionsRequired: 'false',
            sort: 'popularity',
        });
        // Don't filter by mealType — too restrictive, let user search freely

        console.log(`[GalleyRecipe] Searching: "${trimmed}" (${maxResults} results)`);
        const url = `${API_BASE}/recipes/complexSearch?${params}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[GalleyRecipe] API ${resp.status}: ${body}`);
            return [];
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await resp.json()) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results: GalleyMeal[] = (data.results || []).map((r: any) => ({
            id: r.id,
            title: r.title,
            readyInMinutes: r.readyInMinutes || 30,
            servings: r.servings || 2,
            image: r.image
                ? r.image.startsWith('http')
                    ? r.image
                    : `https://img.spoonacular.com/recipes/${r.id}-480x360.jpg`
                : `https://img.spoonacular.com/recipes/${r.id}-480x360.jpg`,
            sourceUrl: r.sourceUrl || '',
            ingredients: parseIngredients(r.extendedIngredients || []),
        }));

        // Cache results
        try {
            localStorage.setItem(cacheKey, JSON.stringify({ results, ts: Date.now() }));
        } catch {
            /* storage full */
        }

        // Persist recipes for offline access
        for (const meal of results) {
            persistRecipe(meal).catch(() => {
                /* non-critical */
            });
        }

        return results;
    } catch (err) {
        console.warn('[GalleyRecipe] Search failed:', err);
        // Fallback to local recipes
        const stored = getStoredRecipes();
        return stored
            .filter((r) => r.title.toLowerCase().includes(trimmed))
            .slice(0, maxResults)
            .map((r) => ({
                id: r.spoonacular_id ?? Date.now(),
                title: r.title,
                readyInMinutes: r.ready_in_minutes,
                servings: r.servings,
                image: r.image_url,
                sourceUrl: r.source_url,
                ingredients: r.ingredients,
            }));
    }
}

/** Clear all cached galley plans */
export function clearGalleyCache(): void {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    keys.forEach((k) => localStorage.removeItem(k));
}

// ── Galley Difficulty Scoring ─────────────────────────────────────────────────

export interface GalleyDifficulty {
    /** 1 (easy, any conditions) → 5 (harbour only) */
    score: 1 | 2 | 3 | 4 | 5;
    /** Max sea state (meters) this recipe is practical in */
    maxSeaStateM: number;
    /** Human label */
    label: string;
    /** Emoji indicator */
    emoji: string;
    /** Color class for UI */
    color: string;
}

const DIFFICULTY_LEVELS: Record<number, Omit<GalleyDifficulty, 'score'>> = {
    1: { maxSeaStateM: 5.0, label: 'Any Conditions', emoji: '🟢', color: 'emerald' },
    2: { maxSeaStateM: 3.0, label: 'Moderate Seas', emoji: '🟢', color: 'emerald' },
    3: { maxSeaStateM: 2.0, label: 'Fair Weather', emoji: '🟡', color: 'amber' },
    4: { maxSeaStateM: 1.5, label: 'Calm Only', emoji: '🟠', color: 'orange' },
    5: { maxSeaStateM: 0.5, label: 'Harbour Only', emoji: '🔴', color: 'red' },
};

// Keywords that push difficulty UP (harder to cook underway)
const HARD_KEYWORDS = [
    // Score 5 — harbour only
    { words: ['flambé', 'flambe', 'sushi', 'soufflé', 'souffle', 'tempura', 'deep fry', 'deep-fry', 'multi-course'], score: 5 },
    // Score 4 — calm only (hot liquids, long cook)
    { words: ['stew', 'soup', 'braise', 'broth', 'chowder', 'ramen', 'pho', 'fondue', 'curry', 'risotto', 'slow cook', 'slow-cook', 'casserole', 'bolognese', 'chili', 'chilli', 'gumbo', 'laksa', 'dahl', 'dal'], score: 4 },
    // Score 3 — fair weather (oven, grill, frying)
    { words: ['roast', 'bake', 'grill', 'bbq', 'barbecue', 'smoke', 'smoked', 'brisket', 'pizza', 'pie', 'lasagna', 'lasagne', 'quiche', 'cake', 'brownie', 'muffin', 'pancake', 'fry', 'fried', 'sauté', 'saute', 'stir-fry', 'stir fry', 'wok'], score: 3 },
];

// Keywords that push difficulty DOWN (easy to make)
const EASY_KEYWORDS = [
    'sandwich', 'wrap', 'toast', 'cereal', 'muesli', 'granola', 'yogurt', 'yoghurt',
    'cold', 'salad', 'fruit', 'smoothie', 'protein bar', 'crackers', 'cheese board',
    'instant', 'no-cook', 'overnight oats', 'tinned', 'canned',
];

/**
 * Score a recipe on how practical it is to cook underway.
 * Uses title keywords, cook time, and ingredient count.
 */
export function getGalleyDifficulty(title: string, readyInMinutes?: number, ingredientCount?: number): GalleyDifficulty {
    const t = title.toLowerCase();

    // 1. Check easy keywords first — these override everything
    if (EASY_KEYWORDS.some((kw) => t.includes(kw))) {
        return { score: 1, ...DIFFICULTY_LEVELS[1] };
    }

    // 2. Check hard keywords — use highest matching score
    let keywordScore = 0;
    for (const group of HARD_KEYWORDS) {
        if (group.words.some((kw) => t.includes(kw))) {
            keywordScore = Math.max(keywordScore, group.score);
        }
    }

    if (keywordScore > 0) {
        return { score: keywordScore as GalleyDifficulty['score'], ...DIFFICULTY_LEVELS[keywordScore] };
    }

    // 3. Fall back to cook time + ingredient count heuristic
    const mins = readyInMinutes || 30;
    const ings = ingredientCount || 5;

    if (mins <= 15 && ings <= 5) return { score: 1, ...DIFFICULTY_LEVELS[1] };
    if (mins <= 30 && ings <= 8) return { score: 2, ...DIFFICULTY_LEVELS[2] };
    if (mins <= 60) return { score: 3, ...DIFFICULTY_LEVELS[3] };
    if (mins <= 120) return { score: 4, ...DIFFICULTY_LEVELS[4] };
    return { score: 5, ...DIFFICULTY_LEVELS[5] };
}
