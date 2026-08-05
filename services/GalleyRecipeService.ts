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
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import {
    captureOwnedMediaAuthorization,
    retainUncertainOwnedMedia,
    retireOwnedMedia,
    type OwnedMediaAuthorization,
} from './OwnedMediaCleanupService';
import { safeExternalHttpUrl, safeImageUrl } from '../utils/safeUrl';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { fetchSpoonacular } from './spoonacularProxy';

const log = createLogger('GalleyRecipe');

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
    /** A named calendar item with no recipe, ingredients, or instructions attached. */
    isSimpleMeal?: boolean;
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

async function getCurrentRecipeUserId(): Promise<string | null> {
    if (!supabase) return null;

    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        if (session?.user.id) return session.user.id;
    } catch {
        // Fall through to a verified lookup. The local session remains
        // usable when the boat is offline and getUser cannot reach Supabase.
    }

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        return user?.id ?? null;
    } catch {
        return null;
    }
}

// ── Image Caching ──────────────────────────────────────────────────────────

/**
 * Cache a recipe image as a base64 data URI in localStorage.
 * Returns the data URI on success, or the original URL on failure.
 */
export async function cacheRecipeImage(imageUrl: string, recipeId: number): Promise<string> {
    if (!imageUrl) return imageUrl;
    const safeUrl = safeImageUrl(imageUrl, typeof window !== 'undefined' ? window.location.href : undefined);
    if (!safeUrl) return '';

    // Already cached?
    const cached = getCachedImage(recipeId);
    if (cached) return cached;

    try {
        const resp = await fetch(safeUrl, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
        if (!resp.ok) return safeUrl;
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
            reader.onerror = () => resolve(safeUrl);
            reader.readAsDataURL(blob);
        });
    } catch {
        return safeUrl; // Network error — use validated original URL
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
    // Keep already-cached offline images usable, but never reach the
    // provider CDN while the paid catalogue is disabled.
    if (!FEATURE_VISIBILITY.spoonacular) return '';
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

    if (!FEATURE_VISIBILITY.spoonacular) return [];

    // 2. Fetch through the server-side Spoonacular proxy. The paid API key
    // must never enter the Vite client bundle.
    try {
        const data = (await fetchSpoonacular('information', {
            recipe_id: spoonacularId,
        })) as { analyzedInstructions?: unknown } | null;
        if (!data) return [];
        const steps = parseInstructions(data.analyzedInstructions);

        // Cache for offline use
        if (steps.length > 0 && stored.length > 0) {
            const updated = {
                ...stored[0],
                instructions: JSON.stringify(steps),
                updated_at: new Date().toISOString(),
            };
            await updateLocal(RECIPE_TABLE, updated.id, updated);
        }

        return steps;
    } catch (err) {
        log.warn('Failed to fetch instructions:', err);
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
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function boundedProviderText(value: unknown, fallback: string, maxLength: number): string {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function boundedProviderNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseIngredients(extendedIngredients: unknown): RecipeIngredient[] {
    if (!Array.isArray(extendedIngredients)) return [];
    return extendedIngredients.slice(0, 200).flatMap((candidate) => {
        const ingredient = asRecord(candidate);
        if (!ingredient) return [];
        const name = boundedProviderText(ingredient.name ?? ingredient.originalName, '', 160);
        if (!name) return [];
        const unit = boundedProviderText(ingredient.unit, '', 40);
        return [
            {
                name,
                amount: boundedProviderNumber(ingredient.amount, 0, 0, 1_000_000),
                unit,
                scalable: isScalable(unit, name),
                aisle: boundedProviderText(ingredient.aisle, 'Other', 80),
            },
        ];
    });
}

/**
 * Parse Spoonacular's analyzedInstructions into RecipeStep[].
 * Spoonacular returns: [{ name: '', steps: [{ number, step, ... }] }]
 */
function parseInstructions(analyzedInstructions: unknown): RecipeStep[] {
    if (!Array.isArray(analyzedInstructions)) return [];
    const steps: RecipeStep[] = [];
    for (const candidateGroup of analyzedInstructions.slice(0, 20)) {
        const group = asRecord(candidateGroup);
        if (group && Array.isArray(group.steps)) {
            for (const candidateStep of group.steps.slice(0, 100 - steps.length)) {
                const step = asRecord(candidateStep);
                if (!step) continue;
                const text = boundedProviderText(step.step, '', 4_000);
                if (!text) continue;
                steps.push({
                    number: boundedProviderNumber(step.number, steps.length + 1, 1, 10_000),
                    step: text,
                });
            }
        }
        if (steps.length >= 100) break;
    }
    return steps;
}

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Generate a galley-friendly meal plan for a passage.
 * Now fetches ingredient details and persists recipes locally.
 */
export async function generateGalleyPlan(days: number, crew: number): Promise<GalleyPlan | null> {
    if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(crew) || crew < 1 || crew > 50) {
        return null;
    }
    if (!FEATURE_VISIBILITY.spoonacular) return null;

    // Check cache first
    const cached = getCached(cacheKey(days, crew));
    if (cached) return cached;

    try {
        const dayPlans: GalleyDayPlan[] = [];
        const uniqueDays = Math.min(days, 7);

        for (let i = 0; i < uniqueDays; i++) {
            const rawData = await fetchSpoonacular('mealplan', {
                target_calories: 3000,
                exclude: 'soufflé,baked alaska',
            });
            const data = asRecord(rawData);
            if (!data || !Array.isArray(data.meals)) return null;
            const providerMeals = data.meals
                .slice(0, 3)
                .map(asRecord)
                .filter((meal): meal is Record<string, unknown> => meal !== null)
                .filter(
                    (meal) =>
                        typeof meal.id === 'number' &&
                        Number.isSafeInteger(meal.id) &&
                        meal.id > 0 &&
                        typeof meal.title === 'string' &&
                        meal.title.trim().length > 0,
                );

            // Fetch full recipe details for ingredients
            const mealIds = providerMeals.map((meal) => meal.id as number);
            const recipeDetails: Record<number, { ingredients: RecipeIngredient[]; instructions: RecipeStep[] }> = {};

            if (mealIds.length > 0) {
                try {
                    const details = await fetchSpoonacular('bulk', {
                        recipe_ids: mealIds,
                    });
                    if (Array.isArray(details)) {
                        for (const candidate of details.slice(0, mealIds.length)) {
                            const detail = asRecord(candidate);
                            const id = detail?.id;
                            if (
                                !detail ||
                                typeof id !== 'number' ||
                                !Number.isSafeInteger(id) ||
                                !mealIds.includes(id)
                            ) {
                                continue;
                            }
                            recipeDetails[id] = {
                                ingredients: parseIngredients(detail.extendedIngredients),
                                instructions: parseInstructions(detail.analyzedInstructions),
                            };
                        }
                    }
                } catch {
                    // Ingredient fetch failed — proceed without ingredients
                }
            }

            const meals: GalleyMeal[] = providerMeals.map((meal) => {
                const id = meal.id as number;
                const image = boundedProviderText(meal.image, '', 2_000);
                const safeProviderImage = safeImageUrl(image);
                return {
                    id,
                    title: boundedProviderText(meal.title, 'Untitled recipe', 200),
                    readyInMinutes: boundedProviderNumber(meal.readyInMinutes, 30, 1, 7 * 24 * 60),
                    servings: boundedProviderNumber(meal.servings, 2, 1, 1_000),
                    image: safeProviderImage ?? `https://img.spoonacular.com/recipes/${id}-480x360.jpg`,
                    sourceUrl: safeExternalHttpUrl(boundedProviderText(meal.sourceUrl, '', 2_000), true) ?? '',
                    ingredients: recipeDetails[id]?.ingredients || [],
                    instructions: recipeDetails[id]?.instructions || [],
                };
            });
            if (meals.length === 0) return null;

            // Persist each recipe locally for offline access
            for (const meal of meals) {
                try {
                    await persistRecipe(meal);
                } catch {
                    /* non-critical */
                }
            }

            const nutrients = asRecord(data.nutrients);
            dayPlans.push({
                day: i + 1,
                meals,
                nutrients: {
                    calories: Math.round(boundedProviderNumber(nutrients?.calories, 3000, 0, 20_000)),
                    protein: Math.round(boundedProviderNumber(nutrients?.protein, 100, 0, 2_000)),
                    fat: Math.round(boundedProviderNumber(nutrients?.fat, 100, 0, 2_000)),
                    carbohydrates: Math.round(boundedProviderNumber(nutrients?.carbohydrates, 300, 0, 5_000)),
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
        log.warn('Failed to generate plan:', err);
        return null;
    }
}

/**
 * Generate a consolidated shopping list from a meal plan.
 * Uses ingredient data from persisted recipes with crew scaling.
 */
export async function getShoppingList(recipeIds: number[]): Promise<ShoppingItem[]> {
    const safeRecipeIds = [...new Set(recipeIds)].filter(
        (id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647,
    );
    if (safeRecipeIds.length === 0 || safeRecipeIds.length > 20) return [];
    if (!FEATURE_VISIBILITY.spoonacular) return [];

    // Check cache
    const listKey = `${CACHE_PREFIX}shop_${[...safeRecipeIds].sort((a, b) => a - b).join(',')}`;
    try {
        const raw = localStorage.getItem(listKey);
        if (raw) return JSON.parse(raw) as ShoppingItem[];
    } catch {
        /* ignore */
    }

    try {
        const recipes = await fetchSpoonacular('bulk', {
            recipe_ids: safeRecipeIds,
        });
        if (!Array.isArray(recipes)) return [];

        const ingredientMap = new Map<string, ShoppingItem>();

        for (const candidate of recipes.slice(0, safeRecipeIds.length)) {
            const recipe = asRecord(candidate);
            if (!recipe) continue;
            for (const ingredient of parseIngredients(recipe.extendedIngredients)) {
                const key = ingredient.name.toLowerCase();
                if (!key) continue;
                const existing = ingredientMap.get(key);
                if (existing) {
                    existing.amount += ingredient.amount;
                } else {
                    ingredientMap.set(key, {
                        name: ingredient.name,
                        amount: ingredient.amount,
                        unit: ingredient.unit,
                        aisle: ingredient.aisle || 'Other',
                        scalable: ingredient.scalable,
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
        log.warn('Failed to get shopping list:', err);
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

const RECIPE_PHOTO_BUCKET = 'recipe-photos';
const STORAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The existing `recipe-photos` bucket is deliberately public because photos
 * attached to Community Galley recipes must render for anonymous viewers.
 * Until private recipe media has its own private bucket + signed-URL flow, a
 * private recipe photo must never be uploaded there.
 */
export class PrivateRecipePhotoUnavailableError extends Error {
    readonly code = 'PRIVATE_RECIPE_PHOTO_UNAVAILABLE';

    constructor() {
        super('Private recipe photos are unavailable in the public beta. Remove the photo or choose Community Galley.');
        this.name = 'PrivateRecipePhotoUnavailableError';
    }
}

export class RecipePhotoUploadError extends Error {
    readonly code = 'RECIPE_PHOTO_UPLOAD_FAILED';

    constructor(message = 'The recipe photo could not be uploaded.') {
        super(message);
        this.name = 'RecipePhotoUploadError';
    }
}

function recipePhotoStoragePath(ownerId: string, recipeId: string): string {
    if (!STORAGE_UUID.test(ownerId) || !STORAGE_UUID.test(recipeId)) {
        throw new RecipePhotoUploadError('The recipe photo path was invalid.');
    }
    return `${ownerId}/${recipeId}.jpg`;
}

function isManagedRecipePhotoUrl(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.pathname.includes(`/recipe-photos/`);
    } catch {
        return false;
    }
}

function managedPhotoPathFromUrl(value: string | null | undefined, ownerId: string, recipeId: string): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        const markers = [
            `/storage/v1/object/public/${RECIPE_PHOTO_BUCKET}/`,
            `/storage/v1/object/sign/${RECIPE_PHOTO_BUCKET}/`,
        ];
        const marker = markers.find((candidate) => url.pathname.includes(candidate));
        if (!marker) return null;
        const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
        if (path.includes('..') || path.includes('\\')) return null;
        const ownerPath = `${ownerId}/${recipeId}.jpg`;
        const legacyPath = `${recipeId}.jpg`;
        return path === ownerPath || path === legacyPath ? path : null;
    } catch {
        return null;
    }
}

function managedPhotoPathsForRecipe(recipe: Pick<StoredRecipe, 'id' | 'image_url'>, ownerId: string): string[] {
    const path = managedPhotoPathFromUrl(recipe.image_url, ownerId, recipe.id);
    return path ? [path] : [];
}

interface RecipeOwnerAuthorization {
    scope: AuthIdentityScope;
    authorization: OwnedMediaAuthorization;
}

async function captureRecipeOwnerAuthorization(ownerId: string): Promise<RecipeOwnerAuthorization | null> {
    if (!supabase) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId || scope.userId !== ownerId || !isAuthIdentityScopeCurrent(scope)) return null;

    const authorization = await captureOwnedMediaAuthorization(scope);
    if (!authorization || !isAuthIdentityScopeCurrent(scope)) return null;

    try {
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        if (error || user?.id !== ownerId || !isAuthIdentityScopeCurrent(scope)) return null;
        return { scope, authorization };
    } catch {
        return null;
    }
}

async function retireRecipePhotoPath(
    scope: AuthIdentityScope,
    authorization: OwnedMediaAuthorization,
    ownerId: string,
    recipeId: string,
    path: string,
): Promise<boolean> {
    if (path === `${ownerId}/${recipeId}.jpg`) {
        return retireOwnedMedia(scope, authorization, RECIPE_PHOTO_BUCKET, path);
    }

    if (path !== `${recipeId}.jpg`) return false;

    // The temporary Storage policy permits a legacy root-level object only
    // while an owned recipe row still exists. Remove it before deleting that
    // ownership proof. If the response is uncertain, keep both the row/local
    // retry handle and a reference-aware cleanup ticket.
    try {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) throw new Error('Recipe owner changed');
        const { error } = await supabase.storage.from(RECIPE_PHOTO_BUCKET).remove([path]);
        if (!error && isAuthIdentityScopeCurrent(scope)) return true;
    } catch (error) {
        log.warn('Legacy recipe photo cleanup is incomplete:', error);
    }

    retainUncertainOwnedMedia(scope, RECIPE_PHOTO_BUCKET, path, {
        kind: 'recipe-photo',
        recipeId,
    });
    return false;
}

async function retireRecipePhotoPaths(
    scope: AuthIdentityScope,
    authorization: OwnedMediaAuthorization,
    ownerId: string,
    recipeId: string,
    paths: Iterable<string>,
): Promise<boolean> {
    let complete = true;
    for (const path of new Set(paths)) {
        if (!(await retireRecipePhotoPath(scope, authorization, ownerId, recipeId, path))) complete = false;
    }
    return complete;
}

type OwnedCloudRecipeTable = 'recipes' | 'community_recipes';

interface OwnedCloudRecipeRow {
    id: string;
    user_id: string;
    image_url: string | null;
    visibility: string;
    [key: string]: unknown;
}

interface OwnedCloudRecipeRows {
    recipes: OwnedCloudRecipeRow | null;
    community_recipes: OwnedCloudRecipeRow | null;
}

interface OwnedCloudRecipePatches {
    recipes: Record<string, unknown>;
    community_recipes: Record<string, unknown>;
}

function isExactOwnedCloudRecipeRow(value: unknown, recipeId: string, ownerId: string): value is OwnedCloudRecipeRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<OwnedCloudRecipeRow>;
    return row.id === recipeId && row.user_id === ownerId;
}

function cloudValuesEqual(actual: unknown, expected: unknown): boolean {
    if (actual == null && expected == null) return true;
    if (typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null) {
        return actual === expected;
    }
    try {
        return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
        return false;
    }
}

function cloudRowMatchesPatch(row: OwnedCloudRecipeRow, patch: Record<string, unknown>): boolean {
    return Object.entries(patch).every(([key, expected]) => {
        // Database triggers own the precise timestamp. Identity and every
        // user-authored value are still checked exactly.
        if (key === 'updated_at') return true;
        return cloudValuesEqual(row[key], expected);
    });
}

async function readOwnedCloudRecipeRows(
    recipeId: string,
    ownerId: string,
    scope: AuthIdentityScope,
): Promise<OwnedCloudRecipeRows | null> {
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const [recipesResult, communityResult] = await Promise.all([
            supabase.from('recipes').select('*').eq('id', recipeId).eq('user_id', ownerId).maybeSingle(),
            supabase.from('community_recipes').select('*').eq('id', recipeId).eq('user_id', ownerId).maybeSingle(),
        ]);
        if (
            recipesResult.error ||
            communityResult.error ||
            !isAuthIdentityScopeCurrent(scope) ||
            (recipesResult.data && !isExactOwnedCloudRecipeRow(recipesResult.data, recipeId, ownerId)) ||
            (communityResult.data && !isExactOwnedCloudRecipeRow(communityResult.data, recipeId, ownerId))
        ) {
            return null;
        }
        return {
            recipes: recipesResult.data as OwnedCloudRecipeRow | null,
            community_recipes: communityResult.data as OwnedCloudRecipeRow | null,
        };
    } catch (error) {
        log.warn('Could not read the owned cloud recipe rows:', error);
        return null;
    }
}

async function updateOwnedCloudRecipeRows(
    recipeId: string,
    ownerId: string,
    scope: AuthIdentityScope,
    before: OwnedCloudRecipeRows,
    patches: OwnedCloudRecipePatches,
): Promise<boolean> {
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const [recipesResult, communityResult] = await Promise.all([
            supabase
                .from('recipes')
                .update(patches.recipes)
                .eq('id', recipeId)
                .eq('user_id', ownerId)
                .select('*')
                .maybeSingle(),
            supabase
                .from('community_recipes')
                .update(patches.community_recipes)
                .eq('id', recipeId)
                .eq('user_id', ownerId)
                .select('*')
                .maybeSingle(),
        ]);
        if (!isAuthIdentityScopeCurrent(scope)) return false;

        const resultByTable = {
            recipes: recipesResult,
            community_recipes: communityResult,
        };
        return (Object.keys(resultByTable) as OwnedCloudRecipeTable[]).every((table) => {
            const result = resultByTable[table];
            if (result.error) return false;
            if (!result.data) return before[table] === null;
            return (
                isExactOwnedCloudRecipeRow(result.data, recipeId, ownerId) &&
                cloudRowMatchesPatch(result.data, patches[table])
            );
        });
    } catch (error) {
        // A network exception may arrive after Postgres committed one or both
        // updates. Keep local state/media untouched; the next retry reads both
        // canonical rows before deciding what is unreferenced.
        log.warn('Cloud recipe update response was incomplete:', error);
        return false;
    }
}

function cloudRowsConfirmPatches(
    before: OwnedCloudRecipeRows,
    after: OwnedCloudRecipeRows,
    patches: OwnedCloudRecipePatches,
): boolean {
    const tables: OwnedCloudRecipeTable[] = ['recipes', 'community_recipes'];
    if (!after.recipes && !after.community_recipes) return false;
    return tables.every((table) => {
        if (before[table] && !after[table]) return false;
        return !after[table] || cloudRowMatchesPatch(after[table], patches[table]);
    });
}

function managedPhotoPathsFromCloudRows(rows: OwnedCloudRecipeRows, ownerId: string, recipeId: string): Set<string> {
    const paths = new Set<string>();
    for (const row of [rows.recipes, rows.community_recipes]) {
        const path = managedPhotoPathFromUrl(row?.image_url, ownerId, recipeId);
        if (path) paths.add(path);
    }
    return paths;
}

/**
 * Upload a recipe photo to Supabase Storage.
 * Compresses to max 800px and JPEG quality before upload to handle
 * low-bandwidth maritime connections (satellite, one-bar cell).
 * Returns the public URL on success and throws on any incomplete upload.
 */
export async function uploadRecipePhoto(
    file: File | Blob,
    recipeId: string,
    ownerId: string,
    capturedAuthorization?: OwnedMediaAuthorization,
): Promise<string> {
    if (!supabase) throw new RecipePhotoUploadError('Recipe photo storage is unavailable.');
    const scope = getAuthIdentityScope();
    if (!scope.userId || scope.userId !== ownerId || !isAuthIdentityScopeCurrent(scope)) {
        throw new RecipePhotoUploadError('The signed-in account changed before the recipe photo upload.');
    }
    const authorization = capturedAuthorization ?? (await captureOwnedMediaAuthorization(scope));
    if (authorization?.ownerId !== ownerId || !isAuthIdentityScopeCurrent(scope)) {
        throw new RecipePhotoUploadError('The recipe photo upload could not be authorized for this account.');
    }

    let uploadBlob: Blob = file;
    try {
        uploadBlob = await compressImage(file, 800);
        log.info(`Compressed photo: ${(file.size / 1024).toFixed(0)}KB → ${(uploadBlob.size / 1024).toFixed(0)}KB`);
    } catch (error) {
        log.warn('Compression failed, uploading original:', error);
    }
    if (!isAuthIdentityScopeCurrent(scope)) {
        throw new RecipePhotoUploadError('The signed-in account changed before the recipe photo upload.');
    }

    const path = recipePhotoStoragePath(ownerId, recipeId);
    let handedOff = false;
    try {
        const { data, error } = await supabase.storage.from(RECIPE_PHOTO_BUCKET).upload(path, uploadBlob, {
            contentType: 'image/jpeg',
            cacheControl: '31536000',
            upsert: true,
        });
        if (error) {
            log.warn('Photo upload failed:', error.message);
            throw new RecipePhotoUploadError(
                'The recipe photo could not be uploaded. Check your connection and try again.',
            );
        }
        if (data?.path !== path) {
            throw new RecipePhotoUploadError('The recipe photo upload could not be confirmed.');
        }
        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new RecipePhotoUploadError('The signed-in account changed during the recipe photo upload.');
        }

        const { data: urlData } = supabase.storage.from(RECIPE_PHOTO_BUCKET).getPublicUrl(path);
        if (!urlData?.publicUrl) {
            throw new RecipePhotoUploadError('The recipe photo URL could not be created.');
        }
        if (!isAuthIdentityScopeCurrent(scope)) {
            throw new RecipePhotoUploadError('The signed-in account changed during the recipe photo upload.');
        }
        handedOff = true;
        return urlData.publicUrl;
    } finally {
        if (!handedOff) {
            await retireOwnedMedia(scope, authorization, RECIPE_PHOTO_BUCKET, path);
        }
    }
}

/**
 * Save a custom recipe to Supabase community_recipes table.
 * Also persists locally for offline access.
 */
export async function saveCustomRecipe(input: CustomRecipeInput): Promise<GalleyMeal | null> {
    if (input.visibility === 'private' && input.imageFile) {
        throw new PrivateRecipePhotoUnavailableError();
    }
    if (!supabase) {
        log.warn('Cannot save custom recipe — no Supabase connection');
        return null;
    }

    const scope = getAuthIdentityScope();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user || scope.userId !== user.id || !isAuthIdentityScopeCurrent(scope)) return null;

    const recipeId = generateUUID();
    let uploadedPhotoPath: string | null = null;
    let authorization: OwnedMediaAuthorization | null = null;
    let databaseOutcome: 'not-started' | 'known-noncommit' | 'ambiguous' | 'committed' = 'not-started';

    try {
        // Upload photo if provided
        let imageUrl = '';
        if (input.imageFile) {
            const photoPath = recipePhotoStoragePath(user.id, recipeId);
            authorization = await captureOwnedMediaAuthorization(scope);
            if (!authorization || !isAuthIdentityScopeCurrent(scope)) {
                throw new RecipePhotoUploadError('The recipe photo upload could not be authorized for this account.');
            }
            imageUrl = await uploadRecipePhoto(input.imageFile, recipeId, user.id, authorization);
            uploadedPhotoPath = photoPath;
            if (!isAuthIdentityScopeCurrent(scope)) return null;
        }

        // Chat profiles are the canonical deployed source for community-facing
        // names. Do not depend on the retired generic `profiles` table here.
        let authorName = 'Anonymous Sailor';
        try {
            const { data: profile } = await supabase
                .from('chat_profiles')
                .select('display_name')
                .eq('user_id', user.id)
                .maybeSingle();
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (profile?.display_name) authorName = profile.display_name;
        } catch {
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            /* use default */
        }

        if (!isAuthIdentityScopeCurrent(scope)) return null;
        databaseOutcome = 'ambiguous';
        let result;
        try {
            result = await supabase
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
                .select('*')
                .maybeSingle();
        } catch (error) {
            // The insert may have committed before the response disappeared.
            // Keep a reference-aware cleanup job; it will read both owner rows
            // and never delete a photo the committed recipe adopted.
            log.warn('saveCustomRecipe response was incomplete:', error);
            return null;
        }

        if (result.error) {
            databaseOutcome = 'known-noncommit';
            log.error('saveCustomRecipe failed:', result.error.message);
            return null;
        }
        const data = result.data;
        if (
            !isExactOwnedCloudRecipeRow(data, recipeId, user.id) ||
            (data.image_url ?? '') !== imageUrl ||
            data.visibility !== input.visibility
        ) {
            // A mutation without the exact returned owner row is not proof of
            // failure or success. Reconciliation must decide before bytes move.
            return null;
        }
        databaseOutcome = 'committed';
        if (!isAuthIdentityScopeCurrent(scope)) return null;

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
            title: typeof data.title === 'string' ? data.title : input.title,
            readyInMinutes: typeof data.ready_in_minutes === 'number' ? data.ready_in_minutes : input.readyInMinutes,
            servings: typeof data.servings === 'number' ? data.servings : input.servings,
            image: data.image_url || '',
            sourceUrl: '',
            ingredients: (data.ingredients as RecipeIngredient[]) || [],
            instructions: (data.instructions as RecipeStep[]) || [],
            source: 'private',
            supabaseId: recipeId,
            authorName,
        };
    } finally {
        if (uploadedPhotoPath && databaseOutcome === 'ambiguous') {
            retainUncertainOwnedMedia(scope, RECIPE_PHOTO_BUCKET, uploadedPhotoPath, {
                kind: 'recipe-photo',
                recipeId,
            });
        } else if (uploadedPhotoPath && databaseOutcome !== 'committed') {
            // No database mutation started, or PostgREST returned a definite
            // non-commit. The exact fresh path cannot be referenced.
            await retireOwnedMedia(scope, authorization, RECIPE_PHOTO_BUCKET, uploadedPhotoPath);
        }
    }
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
    // Check before the provider cache so stale online results cannot leak
    // back into a beta build after the integration has been disabled.
    if (!FEATURE_VISIBILITY.spoonacular) return [];

    const resultLimit = Number.isInteger(maxResults) ? Math.min(12, Math.max(1, maxResults)) : 8;

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
        log.info(`Spoonacular search: "${query}" (${resultLimit} results)`);
        const data = asRecord(await fetchSpoonacular('search', { query, number: resultLimit }));
        if (!data || !Array.isArray(data.results)) return [];
        const results: GalleyMeal[] = data.results.slice(0, resultLimit).flatMap((candidate) => {
            const recipe = asRecord(candidate);
            const id = recipe?.id;
            if (
                !recipe ||
                typeof id !== 'number' ||
                !Number.isSafeInteger(id) ||
                id <= 0 ||
                typeof recipe.title !== 'string' ||
                !recipe.title.trim()
            ) {
                return [];
            }
            const image = boundedProviderText(recipe.image, '', 2_000);
            const safeProviderImage = safeImageUrl(image);
            return [
                {
                    id,
                    title: boundedProviderText(recipe.title, 'Untitled recipe', 200),
                    readyInMinutes: boundedProviderNumber(recipe.readyInMinutes, 30, 1, 7 * 24 * 60),
                    servings: boundedProviderNumber(recipe.servings, 2, 1, 1_000),
                    image: safeProviderImage ?? `https://img.spoonacular.com/recipes/${id}-480x360.jpg`,
                    sourceUrl: safeExternalHttpUrl(boundedProviderText(recipe.sourceUrl, '', 2_000), true) ?? '',
                    ingredients: parseIngredients(recipe.extendedIngredients),
                    instructions: parseInstructions(recipe.analyzedInstructions),
                    source: 'spoonacular' as RecipeSource,
                },
            ];
        });

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
        log.warn('Spoonacular search failed:', err);
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
    1: {
        maxSeaStateM: 5.0,
        label: 'Any Conditions',
        emoji: '🟢',
        color: 'emerald',
    },
    2: {
        maxSeaStateM: 3.0,
        label: 'Moderate Seas',
        emoji: '🟢',
        color: 'emerald',
    },
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
        return {
            score: keywordScore as GalleyDifficulty['score'],
            ...DIFFICULTY_LEVELS[keywordScore],
        };
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
    // Sea State — single-word vessel condition
    { id: 'at_anchor', label: 'Anchored', emoji: '⚓', group: 'sea_state' },
    { id: 'underway', label: 'Underway', emoji: '⛵', group: 'sea_state' },
    { id: 'rough_weather', label: 'Stormy', emoji: '🌊', group: 'sea_state' },
    // Provisioning — single-word ingredient category
    { id: 'fresh_catch', label: 'Seafood', emoji: '🎣', group: 'provisioning' },
    { id: 'fresh_produce', label: 'Produce', emoji: '🥬', group: 'provisioning' },
    { id: 'pantry_staples', label: 'Pantry', emoji: '🥫', group: 'provisioning' },
    // Gear — cooking method (single word or short hyphenated)
    { id: 'one_pot', label: 'One-Pot', emoji: '🍲', group: 'gear' },
    { id: 'stove_top', label: 'Stovetop', emoji: '🔥', group: 'gear' },
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

    // Drop tokens shorter than 3 chars — single letters (e.g. 'a', 'b')
    // would substring-match into half the recipe corpus and ruin the score.
    const MIN_TOKEN_LEN = 3;
    const normHave = haveIngredients.map(normaliseIngredient).filter((t) => t.length >= MIN_TOKEN_LEN);
    const normExclude = excludeIngredients.map(normaliseIngredient).filter((t) => t.length >= MIN_TOKEN_LEN);
    if (normHave.length === 0) return [];
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
        const raw = localStorage.getItem(authScopedStorageKey(FAVOURITES_KEY));
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
        localStorage.setItem(authScopedStorageKey(FAVOURITES_KEY), JSON.stringify([...favs]));
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
    const userId = await getCurrentRecipeUserId();

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

    const currentRecipe = existing[0];
    const ownerId = currentRecipe.user_id;
    const now = new Date().toISOString();
    const targetVisibility = patch.visibility ?? currentRecipe.visibility;
    const effectivePatch =
        targetVisibility === 'personal'
            ? // A personal recipe has no public-photo delivery mechanism in
              // this beta. Clear every image before the local UI can call it
              // personal, including legacy rows already pointing at Storage.
              { ...patch, image_url: '' }
            : patch;

    // Anonymous/offline-only recipes have no cloud ownership or public
    // Storage contract. Preserve their established local-only behaviour.
    if (!ownerId) {
        return updateLocal<StoredRecipe>(RECIPE_TABLE, recipeId, {
            ...effectivePatch,
            updated_at: now,
        } as Partial<StoredRecipe>);
    }

    if (!supabase) return null;
    if (
        effectivePatch.image_url &&
        isManagedRecipePhotoUrl(effectivePatch.image_url) &&
        !managedPhotoPathFromUrl(effectivePatch.image_url, ownerId, recipeId)
    ) {
        // Never let one recipe claim another recipe/owner's managed object.
        return null;
    }

    const owner = await captureRecipeOwnerAuthorization(ownerId);
    if (!owner) return null;

    const before = await readOwnedCloudRecipeRows(recipeId, ownerId, owner.scope);
    if (!before || (!before.recipes && !before.community_recipes)) return null;

    const patches: OwnedCloudRecipePatches = {
        recipes: {
            ...(effectivePatch.title !== undefined ? { title: effectivePatch.title } : {}),
            ...(effectivePatch.instructions !== undefined ? { instructions: effectivePatch.instructions } : {}),
            ...(effectivePatch.image_url !== undefined ? { image_url: effectivePatch.image_url || null } : {}),
            ...(effectivePatch.ready_in_minutes !== undefined
                ? { ready_in_minutes: effectivePatch.ready_in_minutes }
                : {}),
            ...(effectivePatch.servings !== undefined ? { servings: effectivePatch.servings } : {}),
            ...(effectivePatch.ingredients !== undefined ? { ingredients: effectivePatch.ingredients } : {}),
            ...(effectivePatch.tags !== undefined ? { tags: effectivePatch.tags } : {}),
            ...(effectivePatch.visibility !== undefined ? { visibility: effectivePatch.visibility } : {}),
            ...(effectivePatch.is_favorite !== undefined ? { is_favorite: effectivePatch.is_favorite } : {}),
            updated_at: now,
        },
        community_recipes: {
            ...(effectivePatch.title !== undefined ? { title: effectivePatch.title } : {}),
            ...(effectivePatch.image_url !== undefined ? { image_url: effectivePatch.image_url || null } : {}),
            ...(effectivePatch.ready_in_minutes !== undefined
                ? { ready_in_minutes: effectivePatch.ready_in_minutes }
                : {}),
            ...(effectivePatch.servings !== undefined ? { servings: effectivePatch.servings } : {}),
            ...(effectivePatch.ingredients !== undefined ? { ingredients: effectivePatch.ingredients } : {}),
            ...(effectivePatch.tags !== undefined ? { tags: effectivePatch.tags } : {}),
            ...(effectivePatch.visibility !== undefined
                ? {
                      visibility: effectivePatch.visibility === 'shared' ? 'community' : 'private',
                  }
                : {}),
            ...(effectivePatch.instructions !== undefined
                ? {
                      instructions: effectivePatch.instructions
                          .split(/\r?\n/)
                          .map((step) => step.trim())
                          .filter(Boolean)
                          .map((step, index) => ({ number: index + 1, step })),
                  }
                : {}),
            updated_at: now,
        },
    };

    if (!(await updateOwnedCloudRecipeRows(recipeId, ownerId, owner.scope, before, patches))) return null;

    const after = await readOwnedCloudRecipeRows(recipeId, ownerId, owner.scope);
    if (!after || !cloudRowsConfirmPatches(before, after, patches)) return null;

    const oldPaths = managedPhotoPathsFromCloudRows(before, ownerId, recipeId);
    for (const path of managedPhotoPathsForRecipe(currentRecipe, ownerId)) oldPaths.add(path);
    const newPaths = managedPhotoPathsFromCloudRows(after, ownerId, recipeId);
    const pathsToRetire = [...oldPaths].filter((path) => !newPaths.has(path));

    if (
        pathsToRetire.length > 0 &&
        !(await retireRecipePhotoPaths(owner.scope, owner.authorization, ownerId, recipeId, pathsToRetire))
    ) {
        // Cloud rows are already safe, but the unchanged local record and the
        // durable cleanup ticket preserve an honest retry handle.
        return null;
    }
    if (!isAuthIdentityScopeCurrent(owner.scope)) return null;

    return updateLocal<StoredRecipe>(RECIPE_TABLE, recipeId, {
        ...effectivePatch,
        updated_at: now,
    } as Partial<StoredRecipe>);
}

export type RecipeDeleteResult =
    | { status: 'deleted'; scope: 'local' | 'cloud-and-local'; message: string }
    | { status: 'not-found' | 'not-owner' | 'pending'; message: string };

/**
 * Delete a custom recipe without stranding a compatible cloud row or public
 * photo. Cloud-owned recipes are cloud-first: a failure keeps the local row so
 * the owner has an honest retry handle instead of seeing a false success.
 */
export async function deleteCustomRecipe(recipeId: string): Promise<RecipeDeleteResult> {
    const existing = query<StoredRecipe>(RECIPE_TABLE, (r) => r.id === recipeId && r.is_custom);
    if (existing.length === 0) {
        return {
            status: 'not-found',
            message: 'This custom recipe no longer exists on this device.',
        };
    }

    const recipe = existing[0];

    // Anonymous/offline-only recipes have never had an account owner or cloud
    // row. They can be removed locally without manufacturing a sync promise.
    if (!recipe.user_id) {
        try {
            const { deleteLocal: del } = await import('./vessel/LocalDatabase');
            await del(RECIPE_TABLE, recipeId);
            return {
                status: 'deleted',
                scope: 'local',
                message: 'Recipe deleted from this device.',
            };
        } catch {
            return {
                status: 'pending',
                message: 'The local recipe could not be deleted. Try again.',
            };
        }
    }

    if (!supabase) {
        return {
            status: 'pending',
            message: 'Reconnect before deleting this synced recipe. Nothing has been removed yet.',
        };
    }
    const database = supabase;

    const ownerId = recipe.user_id;
    const owner = await captureRecipeOwnerAuthorization(ownerId);
    if (!owner) {
        return {
            status: 'not-owner',
            message: 'Only the recipe owner can delete this synced recipe.',
        };
    }

    try {
        const before = await readOwnedCloudRecipeRows(recipeId, ownerId, owner.scope);
        if (!before) {
            return {
                status: 'pending',
                message: 'The cloud recipe could not be checked safely. Nothing was deleted; try again.',
            };
        }

        let privateRows = before;
        if (before.recipes || before.community_recipes) {
            const privacyPatches: OwnedCloudRecipePatches = {
                recipes: {
                    visibility: 'personal',
                    image_url: null,
                    updated_at: new Date().toISOString(),
                },
                community_recipes: {
                    visibility: 'private',
                    image_url: null,
                    updated_at: new Date().toISOString(),
                },
            };

            // First remove every public reference, but retain the rows as
            // ownership proof for legacy root-level Storage objects.
            if (!(await updateOwnedCloudRecipeRows(recipeId, ownerId, owner.scope, before, privacyPatches))) {
                return {
                    status: 'pending',
                    message: 'The recipe could not be made private safely. Nothing else was deleted; try again.',
                };
            }
            const readBack = await readOwnedCloudRecipeRows(recipeId, ownerId, owner.scope);
            if (!readBack || !cloudRowsConfirmPatches(before, readBack, privacyPatches)) {
                return {
                    status: 'pending',
                    message: 'The private cloud state could not be confirmed. The local recipe was kept for retry.',
                };
            }
            privateRows = readBack;
        }

        const mediaPaths = managedPhotoPathsFromCloudRows(before, ownerId, recipeId);
        for (const path of managedPhotoPathsForRecipe(recipe, ownerId)) mediaPaths.add(path);
        if (
            mediaPaths.size > 0 &&
            !(await retireRecipePhotoPaths(owner.scope, owner.authorization, ownerId, recipeId, mediaPaths))
        ) {
            return {
                status: 'pending',
                message: 'The recipe is private, but photo cleanup is incomplete. The local recipe was kept for retry.',
            };
        }
        if (!isAuthIdentityScopeCurrent(owner.scope)) {
            return {
                status: 'pending',
                message: 'The account changed during deletion. The local recipe was kept for the owner to retry.',
            };
        }

        const deleteOwnedRow = async (table: OwnedCloudRecipeTable): Promise<boolean> => {
            if (!privateRows[table]) return true;
            try {
                const result = await database
                    .from(table)
                    .delete()
                    .eq('id', recipeId)
                    .eq('user_id', ownerId)
                    .select('id, user_id')
                    .maybeSingle();
                return (
                    isAuthIdentityScopeCurrent(owner.scope) &&
                    !result.error &&
                    isExactOwnedCloudRecipeRow(result.data, recipeId, ownerId)
                );
            } catch (error) {
                // A lost response may still mean the delete committed. The
                // unchanged local row makes the next call read back and finish.
                log.warn(`Could not confirm ${table} deletion:`, error);
                return false;
            }
        };

        // Rows are deleted only after media is gone. This order is mandatory
        // for the temporary legacy Storage policy's ownership proof.
        if (!(await deleteOwnedRow('community_recipes'))) {
            return {
                status: 'pending',
                message: 'The community row deletion is incomplete. The local recipe was kept for retry.',
            };
        }
        if (!(await deleteOwnedRow('recipes'))) {
            return {
                status: 'pending',
                message: 'Cloud deletion is incomplete. The local recipe was kept so you can retry.',
            };
        }

        const deletedReadBack = await readOwnedCloudRecipeRows(recipeId, ownerId, owner.scope);
        if (!deletedReadBack || deletedReadBack.recipes || deletedReadBack.community_recipes) {
            return {
                status: 'pending',
                message: 'Cloud deletion could not be verified. The local recipe was kept so you can retry.',
            };
        }

        // Do not let an A -> B account switch delete A's local row after the
        // awaits above. The cloud rows are already safely retired; A can finish
        // local cleanup after returning to that account.
        if (!isAuthIdentityScopeCurrent(owner.scope)) {
            return {
                status: 'pending',
                message: 'The account changed during deletion. Cloud content was removed; local cleanup is pending.',
            };
        }

        const { deleteLocal: del } = await import('./vessel/LocalDatabase');
        await del(RECIPE_TABLE, recipeId);
        return {
            status: 'deleted',
            scope: 'cloud-and-local',
            message: 'Recipe and its photo were deleted everywhere.',
        };
    } catch (error) {
        log.warn('deleteCustomRecipe failed:', error);
        return {
            status: 'pending',
            message: 'The recipe could not be fully deleted. The local copy was kept so you can retry.',
        };
    }
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

function encodeRecipeSharePart(value: string | number): string {
    return encodeURIComponent(String(value));
}

/**
 * Encode a recipe into a chat-shareable string.
 * Format: 🍳RECIPE:id|title|servings|readyMin|imageUrl
 */
export function encodeRecipeShare(recipe: StoredRecipe): string {
    return `${RECIPE_SHARE_PREFIX}${[
        recipe.id,
        recipe.title,
        recipe.servings,
        recipe.ready_in_minutes,
        recipe.image_url || '',
    ]
        .map(encodeRecipeSharePart)
        .join('|')}`;
}

/**
 * Encode a CommunityRecipe (different field names) into the same
 * chat-shareable string. Used when sharing from The Captain's Table.
 */
export function encodeCommunityRecipeShare(recipe: CommunityRecipe): string {
    return `${RECIPE_SHARE_PREFIX}${[
        recipe.supabaseId,
        recipe.title,
        recipe.servings,
        recipe.readyInMinutes,
        recipe.image || '',
    ]
        .map(encodeRecipeSharePart)
        .join('|')}`;
}

export interface RecipeShareData {
    recipeId: string;
    title: string;
    servings: number;
    readyInMinutes: number;
    imageUrl: string;
}

export interface ParsedRecipeShare {
    /** Optional sender note placed on the lines before the encoded recipe. */
    note: string;
    recipe: RecipeShareData;
}

function decodeRecipeSharePart(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        // Keep compatibility with older, unescaped share payloads and
        // malformed percent sequences already stored in chat history.
        return value;
    }
}

/**
 * Parse a complete chat message containing a recipe token. A sailor may
 * include a note on the lines before the token; the token itself must begin
 * a line so ordinary prose mentioning "🍳RECIPE:" is never misclassified.
 */
export function parseRecipeShareMessage(message: string): ParsedRecipeShare | null {
    const lines = message.split(/\r?\n/);
    const tokenLineIndex = lines.findIndex((line) => line.startsWith(RECIPE_SHARE_PREFIX));
    if (tokenLineIndex < 0) return null;

    const payload = lines[tokenLineIndex].slice(RECIPE_SHARE_PREFIX.length);
    const parts = payload.split('|');
    if (parts.length < 4) return null;

    const recipeId = decodeRecipeSharePart(parts[0]).trim();
    const title = decodeRecipeSharePart(parts[1]).trim();
    if (!recipeId || !title) return null;

    return {
        note: [...lines.slice(0, tokenLineIndex), ...lines.slice(tokenLineIndex + 1)].join('\n').trim(),
        recipe: {
            recipeId,
            title,
            servings: parseInt(decodeRecipeSharePart(parts[2]), 10) || 4,
            readyInMinutes: parseInt(decodeRecipeSharePart(parts[3]), 10) || 30,
            imageUrl: decodeRecipeSharePart(parts[4] || ''),
        },
    };
}

/**
 * Decode a recipe share message back into structured data.
 * Returns null if the message is not a valid recipe share.
 */
export function decodeRecipeShare(message: string): RecipeShareData | null {
    return parseRecipeShareMessage(message)?.recipe ?? null;
}

/**
 * Fetch a full recipe by ID (local-first, then Supabase).
 * Used when someone taps a recipe card in chat.
 *
 * Looks in two places on the cloud, in order:
 *   1. `recipes` — the legacy personal-recipe table.
 *   2. `community_recipes` — where saveCustomRecipe + Captain's Table
 *      recipes actually live. Without this fallback, tapping a shared
 *      recipe card in Scuttlebutt would say "Recipe not available
 *      offline" because the lookup pointed at the wrong table.
 *
 * Visibility values differ between the two tables:
 *   - `recipes`            uses 'personal' | 'shared'
 *   - `community_recipes`  uses 'private'  | 'community'
 * We translate community_recipes values onto the StoredRecipe shape
 * (community → 'shared', private → 'personal').
 */
export async function getRecipeById(recipeId: string): Promise<StoredRecipe | null> {
    // Check local first
    const local = query<StoredRecipe>(RECIPE_TABLE, (r) => r.id === recipeId);
    if (local.length > 0) return local[0];

    if (!supabase) return null;

    // 1. Try the `recipes` table (legacy personal recipes).
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
            await insertLocal(RECIPE_TABLE, recipe);
            return recipe;
        }
    } catch {
        // Continue to community fallback
    }

    // 2. Fall back to `community_recipes` (shared/community recipes
    //    created via the Captain's Table or CustomRecipeForm).
    try {
        const { data } = await supabase.from('community_recipes').select('*').eq('id', recipeId).single();

        if (data) {
            // instructions in community_recipes is a JSON array of
            // RecipeStep[]; StoredRecipe.instructions is a string.
            // Stringify the array so RecipeCard can JSON.parse it.
            const instructionsStr =
                typeof data.instructions === 'string' ? data.instructions : JSON.stringify(data.instructions || []);

            const recipe: StoredRecipe = {
                id: data.id,
                spoonacular_id: null,
                user_id: data.user_id,
                title: data.title,
                image_url: data.image_url || '',
                ready_in_minutes: data.ready_in_minutes,
                servings: data.servings,
                source_url: '',
                instructions: instructionsStr,
                ingredients: (data.ingredients as RecipeIngredient[]) || [],
                is_favorite: false,
                is_custom: true,
                visibility: data.visibility === 'community' ? 'shared' : 'personal',
                tags: (data.tags as string[]) || [],
                created_at: data.created_at,
                updated_at: data.updated_at,
            };
            await insertLocal(RECIPE_TABLE, recipe);
            return recipe;
        }
    } catch {
        // Offline — nothing more to try
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
        log.warn('rateRecipe failed:', error.message);
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
        log.warn('reportRecipeImage failed:', error.message);
        return false;
    }
    return true;
}

// ── Post-to-Scuttlebutt ────────────────────────────────────────────────────

export interface ShareToScuttlebuttArgs {
    /** Encoded recipe share token — built via encodeCommunityRecipeShare or encodeRecipeShare */
    recipeShareToken: string;
    /** Target chat channel UUID */
    channelId: string;
    /** Optional sailor note prepended to the recipe card */
    note?: string;
}

/**
 * Post a recipe share token to a Scuttlebutt (chat) channel as a
 * regular chat message. The token is the same `🍳RECIPE:...` payload
 * that RecipeCard.tsx already decodes, so the message renders
 * inline as a tappable recipe card in the channel feed.
 *
 * If a note is supplied, it's prepended above the token on its own
 * line — e.g.
 *   "Made this on the run to Cairns, crew loved it"
 *   🍳RECIPE:abc-123|Beef Stew|4|45|https://...
 *
 * Returns true on success, false if the message failed to send (no
 * auth, muted user, network error — all already handled by
 * ChatService.sendMessage which queues offline as a fallback).
 */
export async function shareRecipeToScuttlebutt({
    recipeShareToken,
    channelId,
    note,
}: ShareToScuttlebuttArgs): Promise<boolean> {
    const trimmedNote = (note || '').trim();
    const fullText = trimmedNote ? `${trimmedNote}\n${recipeShareToken}` : recipeShareToken;

    // Lazy-import ChatService so this module's static graph stays
    // free of chat dependencies (GalleyRecipeService is imported by
    // a lot — recipe forms, meal planner, the diary, etc.). The
    // chat module pulls in supabase realtime + moderation, which is
    // weight we don't want on the recipe path.
    try {
        const { ChatService } = await import('./ChatService');
        const result = await ChatService.sendRecipeShareChannel(channelId, fullText);
        return !!result;
    } catch (e) {
        log.warn('shareRecipeToScuttlebutt failed:', e);
        return false;
    }
}
