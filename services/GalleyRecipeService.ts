/**
 * GalleyRecipeService — Spoonacular API wrapper + offline recipe persistence.
 *
 * Phase 3 upgrade:
 *  - Persists recipes to LocalDatabase for offline use at sea
 *  - Ingredient scaler with scalable/non-scalable detection
 *  - Shopping list generation with crew scaling
 *  - Ready-in-minutes prominently tracked for galley timing
 */

import { getAll, insertLocal, query, updateLocal, generateUUID } from './vessel/LocalDatabase';
import { supabase } from './supabase';
import { compressImage } from './ProfilePhotoService';

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

/** A single step in a recipe's cooking instructions */
export interface RecipeStep {
    number: number;
    step: string;
}

export type RecipeVisibility = 'personal' | 'shared';

/** Source tier for search results */
export type RecipeSource = 'private' | 'community' | 'spoonacular';

export interface StoredRecipe {
    id: string;
    spoonacular_id: number | null;
    user_id: string | null;
    title: string;
    image_url: string;
    ready_in_minutes: number;
    servings: number; // BASE servings (what the recipe is written for)
    source_url: string;
    instructions: string;
    ingredients: RecipeIngredient[];
    is_favorite: boolean;
    is_custom: boolean;
    visibility: RecipeVisibility;
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
    /** Parsed cooking steps (from Spoonacular analyzedInstructions) */
    instructions?: RecipeStep[];
    /** Where this recipe came from in tiered search */
    source?: RecipeSource;
    /** Supabase UUID for custom recipes */
    supabaseId?: string;
    /** Author name for community recipes */
    authorName?: string;
    /** Average rating (1-5 ship's wheels) */
    ratingAvg?: number;
    /** Number of ratings */
    ratingCount?: number;
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
export function scaleIngredient(
    amount: number,
    scalable: boolean,
    recipeServings: number,
    crewCount: number,
    unit?: string,
): number {
    if (!scalable) return amount; // 1 bottle stays 1 bottle
    const ratio = crewCount / Math.max(recipeServings, 1);
    const raw = amount * ratio;

    // "Whole" items must round UP to nearest whole number.
    // You can't buy 0.4 eggs or 0.2 of a medium onion.
    const u = (unit || '').toLowerCase().trim();
    if (isWholeUnit(u)) {
        return Math.ceil(raw);
    }

    // Measured items (g, ml, cups, tsp, tbsp) — round to 1 decimal
    return Math.ceil(raw * 10) / 10;
}

/** Units that represent whole, indivisible items */
const WHOLE_UNITS = new Set([
    '', // no unit = whole item (e.g. "2 eggs")
    'whole',
    'large',
    'medium',
    'small',
    'clove',
    'cloves',
    'head',
    'heads',
    'bunch',
    'bunches',
    'stalk',
    'stalks',
    'sprig',
    'sprigs',
    'leaf',
    'leaves',
    'slice',
    'slices',
    'piece',
    'pieces',
    'fillet',
    'fillets',
    'breast',
    'breasts',
    'thigh',
    'thighs',
    'drumstick',
    'drumsticks',
    'strip',
    'strips',
    'rasher',
    'rashers',
    'ear',
    'ears',
    'link',
    'links',
]);

function isWholeUnit(unit: string): boolean {
    return WHOLE_UNITS.has(unit);
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
        user_id: null,
        title: meal.title,
        image_url: meal.image,
        ready_in_minutes: meal.readyInMinutes,
        servings: meal.servings,
        source_url: meal.sourceUrl,
        instructions: JSON.stringify(meal.instructions || []),
        ingredients: meal.ingredients || [],
        is_favorite: false,
        is_custom: false,
        visibility: 'personal',
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

/**
 * Get cooking instructions for a recipe by spoonacular_id.
 * 1. First checks locally stored recipe
 * 2. If not found or empty, fetches from Spoonacular API and caches
 */
export async function getRecipeInstructions(spoonacularId: number | null): Promise<RecipeStep[]> {
    if (!spoonacularId) return [];

    // 1. Check locally stored recipe
    const stored = query<StoredRecipe>(RECIPE_TABLE, (r) => r.spoonacular_id === spoonacularId);
    if (stored.length > 0 && stored[0].instructions) {
        try {
            const parsed = JSON.parse(stored[0].instructions) as RecipeStep[];
            if (parsed.length > 0) return parsed;
        } catch {
            // Stored instructions are not valid JSON — try fetching
        }
    }

    // 2. Fetch from Spoonacular API
    const apiKey = getApiKey();
    if (!apiKey) return [];

    try {
        const resp = await fetch(
            `${API_BASE}/recipes/${spoonacularId}/information?apiKey=${apiKey}&includeNutrition=false`,
        );
        if (!resp.ok) return [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await resp.json()) as any;
        const steps = parseInstructions(data.analyzedInstructions);

        // Cache for offline use
        if (steps.length > 0 && stored.length > 0) {
            const updated = { ...stored[0], instructions: JSON.stringify(steps), updated_at: new Date().toISOString() };
            await updateLocal(RECIPE_TABLE, updated.id, updated);
        }

        return steps;
    } catch (err) {
        console.warn('[GalleyRecipe] Failed to fetch instructions:', err);
        return [];
    }
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

/**
 * Parse Spoonacular's analyzedInstructions into RecipeStep[].
 * Spoonacular returns: [{ name: '', steps: [{ number, step, ... }] }]
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseInstructions(analyzedInstructions: any): RecipeStep[] {
    if (!analyzedInstructions || !Array.isArray(analyzedInstructions)) return [];
    const steps: RecipeStep[] = [];
    for (const group of analyzedInstructions) {
        if (group.steps && Array.isArray(group.steps)) {
            for (const s of group.steps) {
                steps.push({
                    number: s.number || steps.length + 1,
                    step: (s.step || '').trim(),
                });
            }
        }
    }
    return steps;
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
            const recipeDetails: Record<number, { ingredients: RecipeIngredient[]; instructions: RecipeStep[] }> = {};

            if (mealIds.length > 0) {
                try {
                    const detailResp = await fetch(
                        `${API_BASE}/recipes/informationBulk?apiKey=${apiKey}&ids=${mealIds.join(',')}&includeNutrition=false`,
                    );
                    if (detailResp.ok) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const details = (await detailResp.json()) as any[];
                        for (const detail of details) {
                            recipeDetails[detail.id] = {
                                ingredients: parseIngredients(detail.extendedIngredients),
                                instructions: parseInstructions(detail.analyzedInstructions),
                            };
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
                    ingredients: recipeDetails[m.id]?.ingredients || [],
                    instructions: recipeDetails[m.id]?.instructions || [],
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

// ── Custom Recipe Hub (Supabase) ───────────────────────────────────────────

export interface CustomRecipeInput {
    title: string;
    imageFile?: File | Blob | null;
    readyInMinutes: number;
    servings: number; // per-person
    ingredients: RecipeIngredient[];
    instructions: RecipeStep[];
    visibility: 'private' | 'community';
    tags?: string[];
}

/**
 * Upload a recipe photo to Supabase Storage.
 * Compresses to max 800px and JPEG quality before upload to handle
 * low-bandwidth maritime connections (satellite, one-bar cell).
 * Returns the public URL on success, empty string on failure.
 */
export async function uploadRecipePhoto(file: File | Blob, recipeId: string): Promise<string> {
    if (!supabase) return '';

    // Compress before upload — 800px max for recipe photos (more fidelity than 512px avatars)
    let uploadBlob: Blob = file;
    try {
        uploadBlob = await compressImage(file, 800);
        console.log(
            `[GalleyRecipe] Compressed photo: ${(file.size / 1024).toFixed(0)}KB → ${(uploadBlob.size / 1024).toFixed(0)}KB`,
        );
    } catch (e) {
        console.warn('[GalleyRecipe] Compression failed, uploading original:', e);
        // Fall through with original file
    }

    const path = `${recipeId}.jpg`;

    const { error } = await supabase.storage
        .from('recipe-photos')
        .upload(path, uploadBlob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true });

    if (error) {
        console.warn('[GalleyRecipe] Photo upload failed:', error.message);
        return '';
    }

    const { data: urlData } = supabase.storage.from('recipe-photos').getPublicUrl(path);
    return urlData?.publicUrl || '';
}

/**
 * Save a custom recipe to Supabase community_recipes table.
 * Also persists locally for offline access.
 */
export async function saveCustomRecipe(input: CustomRecipeInput): Promise<GalleyMeal | null> {
    if (!supabase) {
        console.warn('[GalleyRecipe] Cannot save custom recipe — no Supabase connection');
        return null;
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const recipeId = generateUUID();

    // Upload photo if provided
    let imageUrl = '';
    if (input.imageFile) {
        imageUrl = await uploadRecipePhoto(input.imageFile, recipeId);
    }

    // Get display name for community author attribution
    let authorName = 'Anonymous Sailor';
    try {
        const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', user.id).single();
        if (profile?.display_name) authorName = profile.display_name;
    } catch {
        /* use default */
    }

    const { data, error } = await supabase
        .from('community_recipes')
        .insert({
            id: recipeId,
            user_id: user.id,
            title: input.title,
            image_url: imageUrl,
            ready_in_minutes: input.readyInMinutes,
            servings: input.servings,
            ingredients: input.ingredients,
            instructions: input.instructions,
            visibility: input.visibility,
            tags: input.tags || [],
            author_name: authorName,
        })
        .select()
        .single();

    if (error) {
        console.error('[GalleyRecipe] saveCustomRecipe failed:', error.message);
        return null;
    }

    // Also persist locally for offline
    const now = new Date().toISOString();
    const localRecord: StoredRecipe = {
        id: recipeId,
        spoonacular_id: null,
        user_id: user.id,
        title: input.title,
        image_url: imageUrl,
        ready_in_minutes: input.readyInMinutes,
        servings: input.servings,
        source_url: '',
        instructions: JSON.stringify(input.instructions),
        ingredients: input.ingredients,
        is_favorite: false,
        is_custom: true,
        visibility: input.visibility === 'community' ? 'shared' : 'personal',
        tags: input.tags || [],
        created_at: now,
        updated_at: now,
    };
    try {
        await insertLocal(RECIPE_TABLE, localRecord);
    } catch {
        /* non-critical */
    }

    // Return as GalleyMeal for immediate use
    return {
        id: Date.now(), // numeric id for compatibility
        title: data.title,
        readyInMinutes: data.ready_in_minutes,
        servings: data.servings,
        image: data.image_url || '',
        sourceUrl: '',
        ingredients: (data.ingredients as RecipeIngredient[]) || [],
        instructions: (data.instructions as RecipeStep[]) || [],
        source: 'private',
        supabaseId: recipeId,
        authorName: authorName,
    };
}

// ── Recipe Search (3-Tier Pipeline) ────────────────────────────────────────

const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Search user's private recipes from Supabase.
 */
async function searchPrivateRecipes(query: string, maxResults = 8): Promise<GalleyMeal[]> {
    if (!supabase) return [];

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
        .from('community_recipes')
        .select('*')
        .eq('user_id', user.id)
        .ilike('title', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(maxResults);

    if (error || !data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((r: any) => ({
        id: Date.now() + Math.random(), // unique numeric id
        title: r.title,
        readyInMinutes: r.ready_in_minutes || 30,
        servings: r.servings || 1,
        image: r.image_url || '',
        sourceUrl: '',
        ingredients: (r.ingredients as RecipeIngredient[]) || [],
        instructions: (r.instructions as RecipeStep[]) || [],
        source: 'private' as RecipeSource,
        supabaseId: r.id,
        authorName: r.author_name || 'You',
        ratingAvg: r.rating_avg || 0,
        ratingCount: r.rating_count || 0,
    }));
}

/**
 * Search community recipes from Supabase.
 */
async function searchCommunityRecipes(query: string, maxResults = 8): Promise<GalleyMeal[]> {
    if (!supabase) return [];

    // Get current user to exclude their own recipes (already in private tier)
    const {
        data: { user },
    } = await supabase.auth.getUser();
    const userId = user?.id;

    let q = supabase
        .from('community_recipes')
        .select('*')
        .eq('visibility', 'community')
        .ilike('title', `%${query}%`)
        .order('like_count', { ascending: false })
        .limit(maxResults);

    // Exclude own recipes (they're already in the private tier)
    if (userId) {
        q = q.neq('user_id', userId);
    }

    const { data, error } = await q;
    if (error || !data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((r: any) => ({
        id: Date.now() + Math.random(),
        title: r.title,
        readyInMinutes: r.ready_in_minutes || 30,
        servings: r.servings || 1,
        image: r.image_url || '',
        sourceUrl: '',
        ingredients: (r.ingredients as RecipeIngredient[]) || [],
        instructions: (r.instructions as RecipeStep[]) || [],
        source: 'community' as RecipeSource,
        supabaseId: r.id,
        authorName: r.author_name || 'A Fellow Sailor',
        ratingAvg: r.rating_avg || 0,
        ratingCount: r.rating_count || 0,
    }));
}

/**
 * Search Spoonacular API for recipes.
 */
async function searchSpoonacular(query: string, maxResults = 8): Promise<GalleyMeal[]> {
    const apiKey = getApiKey();
    if (!apiKey) return [];

    // Check cache first
    const ck = `${CACHE_PREFIX}search_spoon_${query}_any`;
    try {
        const raw = localStorage.getItem(ck);
        if (raw) {
            const cached = JSON.parse(raw) as { results: GalleyMeal[]; ts: number };
            if (Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) return cached.results;
            localStorage.removeItem(ck);
        }
    } catch {
        /* ignore */
    }

    try {
        const params = new URLSearchParams({
            apiKey,
            query,
            number: String(maxResults),
            addRecipeInformation: 'true',
            fillIngredients: 'true',
            instructionsRequired: 'false',
            sort: 'popularity',
        });

        console.log(`[GalleyRecipe] Spoonacular search: "${query}" (${maxResults} results)`);
        const resp = await fetch(`${API_BASE}/recipes/complexSearch?${params}`);
        if (!resp.ok) return [];

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
            instructions: parseInstructions(r.analyzedInstructions || []),
            source: 'spoonacular' as RecipeSource,
        }));

        // Cache results
        try {
            localStorage.setItem(ck, JSON.stringify({ results, ts: Date.now() }));
        } catch {
            /* full */
        }

        // Persist for offline
        for (const meal of results) {
            persistRecipe(meal).catch(() => {
                /* non-critical */
            });
        }

        return results;
    } catch (err) {
        console.warn('[GalleyRecipe] Spoonacular search failed:', err);
        return [];
    }
}

/**
 * 3-Tier search pipeline: Private → Community → Spoonacular.
 * Results are merged in tier order with deduplication by title.
 *
 * @param searchQuery  - e.g. "chicken curry", "spaghetti"
 * @param mealType     - Optional meal type filter (unused currently)
 * @param maxResults   - Max results per tier (default 8)
 */
export async function searchRecipes(searchQuery: string, mealType?: string, maxResults = 8): Promise<GalleyMeal[]> {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return [];
    void mealType; // reserved for future filtering

    // Run all 3 tiers in parallel for speed
    const [privateResults, communityResults, spoonacularResults] = await Promise.all([
        searchPrivateRecipes(trimmed, maxResults).catch(() => [] as GalleyMeal[]),
        searchCommunityRecipes(trimmed, maxResults).catch(() => [] as GalleyMeal[]),
        searchSpoonacular(trimmed, maxResults).catch(() => [] as GalleyMeal[]),
    ]);

    // Merge in tier order: private first, then community, then spoonacular
    // Deduplicate by normalized title
    const seen = new Set<string>();
    const merged: GalleyMeal[] = [];

    for (const meal of [...privateResults, ...communityResults, ...spoonacularResults]) {
        const key = meal.title.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(meal);
    }

    // If no Supabase results and no Spoonacular, fall back to local DB
    if (merged.length === 0) {
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
                source: 'private' as RecipeSource,
            }));
    }

    return merged;
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
    {
        words: ['flambé', 'flambe', 'sushi', 'soufflé', 'souffle', 'tempura', 'deep fry', 'deep-fry', 'multi-course'],
        score: 5,
    },
    // Score 4 — calm only (hot liquids, long cook)
    {
        words: [
            'stew',
            'soup',
            'braise',
            'broth',
            'chowder',
            'ramen',
            'pho',
            'fondue',
            'curry',
            'risotto',
            'slow cook',
            'slow-cook',
            'casserole',
            'bolognese',
            'chili',
            'chilli',
            'gumbo',
            'laksa',
            'dahl',
            'dal',
        ],
        score: 4,
    },
    // Score 3 — fair weather (oven, grill, frying)
    {
        words: [
            'roast',
            'bake',
            'grill',
            'bbq',
            'barbecue',
            'smoke',
            'smoked',
            'brisket',
            'pizza',
            'pie',
            'lasagna',
            'lasagne',
            'quiche',
            'cake',
            'brownie',
            'muffin',
            'pancake',
            'fry',
            'fried',
            'sauté',
            'saute',
            'stir-fry',
            'stir fry',
            'wok',
        ],
        score: 3,
    },
];

// Keywords that push difficulty DOWN (easy to make)
const EASY_KEYWORDS = [
    'sandwich',
    'wrap',
    'toast',
    'cereal',
    'muesli',
    'granola',
    'yogurt',
    'yoghurt',
    'cold',
    'salad',
    'fruit',
    'smoothie',
    'protein bar',
    'crackers',
    'cheese board',
    'instant',
    'no-cook',
    'overnight oats',
    'tinned',
    'canned',
];

/**
 * Score a recipe on how practical it is to cook underway.
 * Uses title keywords, cook time, and ingredient count.
 */
export function getGalleyDifficulty(
    title: string,
    readyInMinutes?: number,
    ingredientCount?: number,
): GalleyDifficulty {
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

// ── Nautical Tags — Auto-Classification ────────────────────────────────────

export type NauticalTag =
    // Sea State
    | 'at_anchor'
    | 'underway'
    | 'rough_weather'
    // Provisioning
    | 'fresh_catch'
    | 'fresh_produce'
    | 'pantry_staples'
    // Galley Gear
    | 'one_pot'
    | 'oven'
    | 'stove_top'
    | 'no_cook';

export interface NauticalTagMeta {
    id: NauticalTag;
    label: string;
    emoji: string;
    group: 'sea_state' | 'provisioning' | 'gear';
}

export const NAUTICAL_TAG_DEFS: NauticalTagMeta[] = [
    // Sea State
    { id: 'at_anchor', label: 'At Anchor', emoji: '⚓', group: 'sea_state' },
    { id: 'underway', label: 'Underway', emoji: '⛵', group: 'sea_state' },
    { id: 'rough_weather', label: 'Rough Weather', emoji: '🌊', group: 'sea_state' },
    // Provisioning
    { id: 'fresh_catch', label: 'Fresh Catch', emoji: '🎣', group: 'provisioning' },
    { id: 'fresh_produce', label: 'Fresh Produce', emoji: '🥬', group: 'provisioning' },
    { id: 'pantry_staples', label: 'Pantry Staples', emoji: '🥫', group: 'provisioning' },
    // Gear
    { id: 'one_pot', label: 'One-Pot', emoji: '🍲', group: 'gear' },
    { id: 'stove_top', label: 'Stove-Top', emoji: '🔥', group: 'gear' },
    { id: 'oven', label: 'Oven', emoji: '♨️', group: 'gear' },
    { id: 'no_cook', label: 'No-Cook', emoji: '❄️', group: 'gear' },
];

// Ingredient keywords for provisioning classification
const FRESH_CATCH_KEYWORDS = [
    'fish',
    'tuna',
    'mahi',
    'snapper',
    'wahoo',
    'dorado',
    'squid',
    'calamari',
    'lobster',
    'crab',
    'prawn',
    'shrimp',
    'oyster',
    'mussel',
    'clam',
    'crayfish',
    'octopus',
    'sashimi',
    'ceviche',
];
const FRESH_PRODUCE_KEYWORDS = [
    'lettuce',
    'spinach',
    'avocado',
    'tomato',
    'cucumber',
    'capsicum',
    'pepper',
    'zucchini',
    'broccoli',
    'mushroom',
    'onion',
    'garlic',
    'lemon',
    'lime',
    'herb',
    'basil',
    'cilantro',
    'parsley',
    'mint',
    'banana',
    'apple',
    'mango',
    'berries',
];
const PANTRY_KEYWORDS = [
    'canned',
    'tinned',
    'can of',
    'tin of',
    'dried',
    'pasta',
    'rice',
    'noodle',
    'lentil',
    'bean',
    'chickpea',
    'flour',
    'oat',
    'powdered',
    'instant',
    'long-life',
    'uht',
    'shelf-stable',
    'jerky',
    'crackers',
    'couscous',
];

const ONE_POT_KEYWORDS = [
    'one pot',
    'one-pot',
    'one pan',
    'one-pan',
    'stew',
    'chili',
    'chilli',
    'curry',
    'soup',
    'casserole',
    'risotto',
    'dal',
    'dahl',
    'gumbo',
    'jambalaya',
    'chowder',
];
const OVEN_KEYWORDS = [
    'bake',
    'roast',
    'baked',
    'roasted',
    'oven',
    'broil',
    'gratin',
    'lasagna',
    'lasagne',
    'pizza',
    'pie',
    'quiche',
    'casserole',
    'brownie',
    'cake',
    'muffin',
];
const STOVE_KEYWORDS = [
    'fry',
    'fried',
    'sauté',
    'saute',
    'stir-fry',
    'stir fry',
    'wok',
    'pan-fry',
    'boil',
    'simmer',
    'poach',
    'scramble',
    'sear',
];

/**
 * Auto-derive nautical tags from a recipe's title, ingredients, and cook time.
 * Runs client-side — no network needed.
 */
export function deriveNauticalTags(
    title: string,
    ingredients: RecipeIngredient[],
    readyInMinutes?: number,
    manualTags?: string[],
): NauticalTag[] {
    const tags = new Set<NauticalTag>();
    const t = title.toLowerCase();
    const ingNames = ingredients.map((i) => i.name.toLowerCase()).join(' ');
    const combined = `${t} ${ingNames}`;

    // Add any manual tags that are valid NauticalTags
    if (manualTags) {
        for (const mt of manualTags) {
            if (NAUTICAL_TAG_DEFS.some((d) => d.id === mt)) {
                tags.add(mt as NauticalTag);
            }
        }
    }

    // --- Sea State (from difficulty score) ---
    const diff = getGalleyDifficulty(title, readyInMinutes, ingredients.length);
    if (diff.score <= 2) {
        tags.add('rough_weather');
        tags.add('underway');
        tags.add('at_anchor');
    } else if (diff.score === 3) {
        tags.add('underway');
        tags.add('at_anchor');
    } else {
        tags.add('at_anchor');
    }

    // --- Provisioning ---
    if (FRESH_CATCH_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('fresh_catch');
    if (FRESH_PRODUCE_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('fresh_produce');
    if (PANTRY_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('pantry_staples');
    // If no provisioning tag derived, check ingredient aisles
    if (!tags.has('fresh_catch') && !tags.has('fresh_produce') && !tags.has('pantry_staples')) {
        const hasPerishable = ingredients.some((i) => ['Produce', 'Seafood', 'Meat'].includes(i.aisle));
        tags.add(hasPerishable ? 'fresh_produce' : 'pantry_staples');
    }

    // --- Galley Gear ---
    if (EASY_KEYWORDS.some((kw) => t.includes(kw)) || (readyInMinutes && readyInMinutes <= 5)) {
        tags.add('no_cook');
    }
    if (ONE_POT_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('one_pot');
    if (OVEN_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('oven');
    if (STOVE_KEYWORDS.some((kw) => combined.includes(kw))) tags.add('stove_top');
    // Default to stove_top if no gear tag
    if (!tags.has('no_cook') && !tags.has('one_pot') && !tags.has('oven') && !tags.has('stove_top')) {
        tags.add('stove_top');
    }

    return Array.from(tags);
}

// ── Bilge Dive — Ingredient Reverse Search ─────────────────────────────────

export interface BilgeDiveResult {
    recipe: CommunityRecipe;
    matchedIngredients: string[];
    totalSearched: number;
    matchPercent: number;
}

/** Normalise an ingredient name for fuzzy comparison */
function normaliseIngredient(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/s$/, '') // strip trailing 's' (plurals)
        .replace(/es$/, '') // strip 'es' plurals
        .replace(/ies$/, 'y') // berries → berry
        .replace(/\s+/g, ' ');
}

/**
 * Bilge Dive — "What do I have?" ingredient-based reverse search.
 * Scans recipes locally, scores by how many searched ingredients match.
 * Fully offline — no network needed.
 *
 * @param recipes       — the loaded recipe set to search against
 * @param haveIngredients — ingredients the user has (e.g. ["rice", "canned tomatoes"])
 * @param excludeIngredients — ingredients to filter OUT (e.g. ["dairy", "fresh meat"])
 * @param minMatchPercent — minimum match threshold (default 30%)
 */
export function bilgeDiveSearch(
    recipes: CommunityRecipe[],
    haveIngredients: string[],
    excludeIngredients: string[] = [],
    minMatchPercent: number = 30,
): BilgeDiveResult[] {
    if (haveIngredients.length === 0) return [];

    const normHave = haveIngredients.map(normaliseIngredient);
    const normExclude = excludeIngredients.map(normaliseIngredient);
    const results: BilgeDiveResult[] = [];

    for (const recipe of recipes) {
        const recipeIngs = (recipe.ingredients || []).map((i) => normaliseIngredient(i.name));

        // Check exclusions — skip if recipe contains any excluded ingredient
        if (normExclude.length > 0) {
            const hasExcluded = normExclude.some((ex) => recipeIngs.some((ri) => ri.includes(ex) || ex.includes(ri)));
            if (hasExcluded) continue;
        }

        // Score matches — fuzzy substring matching
        const matched: string[] = [];
        for (const have of normHave) {
            const found = recipeIngs.some((ri) => ri.includes(have) || have.includes(ri));
            if (found) matched.push(have);
        }

        const matchPercent = Math.round((matched.length / normHave.length) * 100);
        if (matchPercent >= minMatchPercent) {
            results.push({
                recipe,
                matchedIngredients: matched,
                totalSearched: normHave.length,
                matchPercent,
            });
        }
    }

    // Sort by match percentage descending, then by rating
    return results.sort((a, b) => b.matchPercent - a.matchPercent || b.recipe.ratingAvg - a.recipe.ratingAvg);
}

// ── Favourites (Local-Only) ────────────────────────────────────────────────

const FAVOURITES_KEY = `${CACHE_PREFIX}favourites`;

/** Get set of favourite recipe IDs from localStorage */
export function getFavouriteIds(): Set<string> {
    try {
        const raw = localStorage.getItem(FAVOURITES_KEY);
        if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
        /* ignore */
    }
    return new Set();
}

/** Toggle a recipe as favourite. Returns new favourite state. */
export function toggleFavourite(recipeId: string): boolean {
    const favs = getFavouriteIds();
    const isFav = favs.has(recipeId);
    if (isFav) {
        favs.delete(recipeId);
    } else {
        favs.add(recipeId);
    }
    try {
        localStorage.setItem(FAVOURITES_KEY, JSON.stringify([...favs]));
    } catch {
        /* storage full */
    }
    return !isFav;
}

// ── Custom Recipe CRUD ─────────────────────────────────────────────────────

export interface CreateRecipeInput {
    title: string;
    instructions: string;
    image_url?: string;
    ready_in_minutes: number;
    servings: number;
    ingredients: RecipeIngredient[];
    tags: string[];
    visibility: RecipeVisibility;
}

/**
 * Create a custom recipe.
 * Saves locally (offline-first) and syncs to Supabase.
 */
export async function createCustomRecipe(input: CreateRecipeInput): Promise<StoredRecipe | null> {
    const now = new Date().toISOString();
    let userId: string | null = null;

    // Get current user ID
    if (supabase) {
        const { data } = await supabase.auth.getUser();
        userId = data.user?.id || null;
    }

    const recipe: StoredRecipe = {
        id: generateUUID(),
        spoonacular_id: null,
        user_id: userId,
        title: input.title.trim(),
        image_url: input.image_url || '',
        ready_in_minutes: input.ready_in_minutes,
        servings: input.servings,
        source_url: '',
        instructions: input.instructions.trim(),
        ingredients: input.ingredients.map((ing) => ({
            ...ing,
            scalable: isScalable(ing.unit, ing.name),
        })),
        is_favorite: false,
        is_custom: true,
        visibility: input.visibility,
        tags: input.tags,
        created_at: now,
        updated_at: now,
    };

    // Save locally
    await insertLocal(RECIPE_TABLE, recipe);

    // Sync to Supabase
    if (supabase && userId) {
        try {
            await supabase.from('recipes').upsert({
                id: recipe.id,
                user_id: userId,
                title: recipe.title,
                instructions: recipe.instructions,
                image_url: recipe.image_url || null,
                ready_in_minutes: recipe.ready_in_minutes,
                servings: recipe.servings,
                ingredients: recipe.ingredients,
                tags: recipe.tags,
                visibility: recipe.visibility,
                is_favorite: false,
                created_at: now,
                updated_at: now,
            });
        } catch {
            // Offline — local copy is primary
        }
    }

    return recipe;
}

/**
 * Update a custom recipe (only user-created recipes).
 */
export async function updateCustomRecipe(
    recipeId: string,
    patch: Partial<
        Pick<
            StoredRecipe,
            | 'title'
            | 'instructions'
            | 'image_url'
            | 'ready_in_minutes'
            | 'servings'
            | 'ingredients'
            | 'tags'
            | 'visibility'
            | 'is_favorite'
        >
    >,
): Promise<StoredRecipe | null> {
    const existing = query<StoredRecipe>(RECIPE_TABLE, (r) => r.id === recipeId && r.is_custom);
    if (existing.length === 0) return null;

    const now = new Date().toISOString();
    const updated = updateLocal<StoredRecipe>(RECIPE_TABLE, recipeId, {
        ...patch,
        updated_at: now,
    } as Partial<StoredRecipe>);

    // Sync to Supabase
    if (supabase) {
        try {
            await supabase
                .from('recipes')
                .update({ ...patch, updated_at: now })
                .eq('id', recipeId);
        } catch {
            // Offline — local update is primary
        }
    }

    return updated;
}

/**
 * Delete a custom recipe.
 */
export async function deleteCustomRecipe(recipeId: string): Promise<boolean> {
    const existing = query<StoredRecipe>(RECIPE_TABLE, (r) => r.id === recipeId && r.is_custom);
    if (existing.length === 0) return false;

    try {
        const { deleteLocal: del } = await import('./vessel/LocalDatabase');
        await del(RECIPE_TABLE, recipeId);
    } catch {
        return false;
    }

    // Delete from Supabase
    if (supabase) {
        try {
            await supabase.from('recipes').delete().eq('id', recipeId);
        } catch {
            // Offline — queued for next sync
        }
    }

    return true;
}

/**
 * Get all custom recipes created by the current user.
 * Merges local + Supabase (cloud takes precedence if newer).
 */
export async function getMyRecipes(): Promise<StoredRecipe[]> {
    // Local-first
    const local = query<StoredRecipe>(RECIPE_TABLE, (r) => r.is_custom);

    // Try to hydrate from Supabase
    if (supabase) {
        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (user) {
                const { data } = await supabase
                    .from('recipes')
                    .select('*')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });

                if (data && data.length > 0) {
                    // Merge: cloud recipes not in local → insert locally
                    const localIds = new Set(local.map((r) => r.id));
                    for (const cloudRecipe of data) {
                        if (!localIds.has(cloudRecipe.id)) {
                            const mapped: StoredRecipe = {
                                id: cloudRecipe.id,
                                spoonacular_id: null,
                                user_id: cloudRecipe.user_id,
                                title: cloudRecipe.title,
                                image_url: cloudRecipe.image_url || '',
                                ready_in_minutes: cloudRecipe.ready_in_minutes,
                                servings: cloudRecipe.servings,
                                source_url: '',
                                instructions: cloudRecipe.instructions || '',
                                ingredients: cloudRecipe.ingredients || [],
                                is_favorite: cloudRecipe.is_favorite || false,
                                is_custom: true,
                                visibility: cloudRecipe.visibility || 'personal',
                                tags: cloudRecipe.tags || [],
                                created_at: cloudRecipe.created_at,
                                updated_at: cloudRecipe.updated_at,
                            };
                            await insertLocal(RECIPE_TABLE, mapped);
                            local.push(mapped);
                        }
                    }
                }
            }
        } catch {
            // Offline — return local only
        }
    }

    return local.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Get shared recipes from the community (Supabase only).
 * Excludes the current user's own recipes.
 */
export async function getSharedRecipes(limit = 50): Promise<StoredRecipe[]> {
    if (!supabase) return [];

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        const userId = user?.id;

        let q = supabase
            .from('recipes')
            .select('*')
            .eq('visibility', 'shared')
            .order('created_at', { ascending: false })
            .limit(limit);

        // Exclude own recipes from shared feed
        if (userId) {
            q = q.neq('user_id', userId);
        }

        const { data } = await q;
        if (!data) return [];

        return data.map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (r: any) =>
                ({
                    id: r.id,
                    spoonacular_id: null,
                    user_id: r.user_id,
                    title: r.title,
                    image_url: r.image_url || '',
                    ready_in_minutes: r.ready_in_minutes,
                    servings: r.servings,
                    source_url: '',
                    instructions: r.instructions || '',
                    ingredients: r.ingredients || [],
                    is_favorite: false,
                    is_custom: true,
                    visibility: r.visibility,
                    tags: r.tags || [],
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                }) as StoredRecipe,
        );
    } catch {
        return [];
    }
}

// ── Recipe Share Payload ───────────────────────────────────────────────────

export const RECIPE_SHARE_PREFIX = '🍳RECIPE:';

/**
 * Encode a recipe into a chat-shareable string.
 * Format: 🍳RECIPE:id|title|servings|readyMin|imageUrl
 */
export function encodeRecipeShare(recipe: StoredRecipe): string {
    return `${RECIPE_SHARE_PREFIX}${recipe.id}|${recipe.title}|${recipe.servings}|${recipe.ready_in_minutes}|${recipe.image_url || ''}`;
}

/**
 * Decode a recipe share message back into structured data.
 * Returns null if the message is not a valid recipe share.
 */
export function decodeRecipeShare(message: string): {
    recipeId: string;
    title: string;
    servings: number;
    readyInMinutes: number;
    imageUrl: string;
} | null {
    if (!message.startsWith(RECIPE_SHARE_PREFIX)) return null;
    const payload = message.slice(RECIPE_SHARE_PREFIX.length);
    const parts = payload.split('|');
    if (parts.length < 4) return null;

    return {
        recipeId: parts[0],
        title: parts[1],
        servings: parseInt(parts[2], 10) || 4,
        readyInMinutes: parseInt(parts[3], 10) || 30,
        imageUrl: parts[4] || '',
    };
}

/**
 * Fetch a full recipe by ID (local-first, then Supabase).
 * Used when someone taps a recipe card in chat.
 */
export async function getRecipeById(recipeId: string): Promise<StoredRecipe | null> {
    // Check local first
    const local = query<StoredRecipe>(RECIPE_TABLE, (r) => r.id === recipeId);
    if (local.length > 0) return local[0];

    // Fetch from Supabase
    if (supabase) {
        try {
            const { data } = await supabase.from('recipes').select('*').eq('id', recipeId).single();

            if (data) {
                const recipe: StoredRecipe = {
                    id: data.id,
                    spoonacular_id: null,
                    user_id: data.user_id,
                    title: data.title,
                    image_url: data.image_url || '',
                    ready_in_minutes: data.ready_in_minutes,
                    servings: data.servings,
                    source_url: '',
                    instructions: data.instructions || '',
                    ingredients: data.ingredients || [],
                    is_favorite: data.is_favorite || false,
                    is_custom: true,
                    visibility: data.visibility || 'personal',
                    tags: data.tags || [],
                    created_at: data.created_at,
                    updated_at: data.updated_at,
                };
                // Cache locally for offline access
                await insertLocal(RECIPE_TABLE, recipe);
                return recipe;
            }
        } catch {
            // Offline
        }
    }

    return null;
}

// ── Captain's Table (Community Browse & Ratings) ───────────────────────────

export type CaptainsTableSort = 'top_rated' | 'newest' | 'prep_time';

export interface CommunityRecipe extends GalleyMeal {
    supabaseId: string;
    authorName: string;
    ratingAvg: number;
    ratingCount: number;
    createdAt: string;
    /** Auto-derived nautical tags — computed client-side after fetch */
    nauticalTags: NauticalTag[];
    /** Manual tags from the recipe author */
    manualTags: string[];
}

/**
 * Browse community recipes — sorted by rating, recency, or prep time.
 * Loads 50 recipes for client-side filtering. Used by The Captain's Table.
 */
export async function browseCommunityRecipes(
    limit = 50,
    offset = 0,
    sortBy: CaptainsTableSort = 'top_rated',
): Promise<CommunityRecipe[]> {
    if (!supabase) return [];

    const orderCol = sortBy === 'top_rated' ? 'rating_avg' : sortBy === 'prep_time' ? 'ready_in_minutes' : 'created_at';
    const ascending = sortBy === 'prep_time'; // fastest first

    const { data, error } = await supabase
        .from('community_recipes')
        .select('*')
        .eq('visibility', 'community')
        .order(orderCol, { ascending })
        .range(offset, offset + limit - 1);

    if (error || !data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((r: any) => {
        const ingredients = (r.ingredients as RecipeIngredient[]) || [];
        const manualTags = (r.tags as string[]) || [];
        return {
            id: Date.now() + Math.random(),
            title: r.title,
            readyInMinutes: r.ready_in_minutes || 30,
            servings: r.servings || 1,
            image: r.image_url || '',
            sourceUrl: '',
            ingredients,
            instructions: (r.instructions as RecipeStep[]) || [],
            source: 'community' as RecipeSource,
            supabaseId: r.id,
            authorName: r.author_name || 'A Fellow Sailor',
            ratingAvg: r.rating_avg || 0,
            ratingCount: r.rating_count || 0,
            createdAt: r.created_at,
            nauticalTags: deriveNauticalTags(r.title, ingredients, r.ready_in_minutes, manualTags),
            manualTags,
        };
    });
}

/**
 * Rate a community recipe (1-5 ship's wheels).
 * Upserts — calling again updates the existing rating.
 */
export async function rateRecipe(recipeId: string, rating: number): Promise<boolean> {
    if (!supabase || rating < 1 || rating > 5) return false;

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { error } = await supabase
        .from('recipe_ratings')
        .upsert({ recipe_id: recipeId, user_id: user.id, rating }, { onConflict: 'recipe_id,user_id' });

    if (error) {
        console.warn('[GalleyRecipe] rateRecipe failed:', error.message);
        return false;
    }

    return true;
}

/**
 * Get the current user's rating for a recipe (or null if unrated).
 */
export async function getUserRating(recipeId: string): Promise<number | null> {
    if (!supabase) return null;

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
        .from('recipe_ratings')
        .select('rating')
        .eq('recipe_id', recipeId)
        .eq('user_id', user.id)
        .single();

    if (error || !data) return null;
    return data.rating;
}

/**
 * Report a recipe image as inappropriate.
 * Inserts into chat_reports with recipe context for mod review.
 */
export async function reportRecipeImage(recipeId: string, reason: string = 'inappropriate_image'): Promise<boolean> {
    if (!supabase) return false;

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { error } = await supabase.from('chat_reports').insert({
        message_id: recipeId, // reuse column for recipe ID
        reporter_id: user.id,
        reason,
        details: `Recipe image reported: ${recipeId}`,
    });

    if (error) {
        console.warn('[GalleyRecipe] reportRecipeImage failed:', error.message);
        return false;
    }
    return true;
}
