/**
 * PassageProvisionsService — The Middleman between Recipes and Ship's Stores.
 *
 * Handles the bridge logic:
 *  1. Takes recipe ingredients + crew scaling
 *  2. Fuzzy-matches against Ship's Stores (inventory_items)
 *  3. Calculates shortfalls (what you need to buy)
 *  4. Learns ingredient aliases from user corrections
 *
 * All operations are offline-first via LocalDatabase.
 */

import { getAll, query, insertLocal, generateUUID } from './vessel/LocalDatabase';
import { scaleIngredient, type RecipeIngredient, type GalleyPlan } from './GalleyRecipeService';
import type { StoresItem } from '../types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProvisionItem {
    id: string;
    passage_name: string;
    recipe_title: string;
    ingredient_name: string;
    required_qty: number;
    unit: string;
    scalable: boolean;
    store_item_id: string | null; // Matched store item
    store_item_name: string | null; // For display
    on_hand_qty: number;
    shortfall_qty: number;
    status: 'needed' | 'have' | 'purchased';
}

export interface ProvisionSummary {
    totalIngredients: number;
    matched: number;
    shortfalls: number;
    fullyStocked: number;
    items: ProvisionItem[];
}

export interface FuzzyMatch {
    item: StoresItem;
    score: number; // 0-1, higher = better match
    matchType: 'exact' | 'alias' | 'fuzzy';
}

// ── Alias Cache ────────────────────────────────────────────────────────────
// Persists user-corrected mappings: "cilantro" → store-item-uuid

const ALIAS_KEY = 'thalassa_ingredient_aliases';

/** Get the alias map from localStorage */
function getAliases(): Record<string, string> {
    try {
        const raw = localStorage.getItem(ALIAS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Save an alias mapping */
export function setAlias(ingredientName: string, storeItemId: string): void {
    const aliases = getAliases();
    aliases[ingredientName.toLowerCase().trim()] = storeItemId;
    try {
        localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
    } catch {
        /* storage full */
    }
}

/** Remove an alias */
export function removeAlias(ingredientName: string): void {
    const aliases = getAliases();
    delete aliases[ingredientName.toLowerCase().trim()];
    try {
        localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
    } catch {
        /* ignore */
    }
}

/** Get all aliases (for debug/display) */
export function getAllAliases(): Record<string, string> {
    return getAliases();
}

// ── Fuzzy Matching ─────────────────────────────────────────────────────────

/**
 * Find the best matching Ship's Stores item for a recipe ingredient.
 * Three-tier matching: exact → alias → fuzzy.
 */
export function findStoreMatch(ingredientName: string, storeItems: StoresItem[]): FuzzyMatch | null {
    const needle = ingredientName.toLowerCase().trim();
    if (!needle || storeItems.length === 0) return null;

    // ── Tier 1: Exact match ──
    const exact = storeItems.find((s) => s.item_name.toLowerCase().trim() === needle);
    if (exact) return { item: exact, score: 1.0, matchType: 'exact' };

    // ── Tier 2: Alias match ──
    const aliases = getAliases();
    const aliasId = aliases[needle];
    if (aliasId) {
        const aliased = storeItems.find((s) => s.id === aliasId);
        if (aliased) return { item: aliased, score: 0.95, matchType: 'alias' };
    }

    // ── Tier 3: Fuzzy match ──
    let bestMatch: FuzzyMatch | null = null;

    for (const storeItem of storeItems) {
        const storeName = storeItem.item_name.toLowerCase().trim();

        // Substring match: "beef" in "Beef Brisket" or "brisket" in "Beef Brisket"
        if (storeName.includes(needle) || needle.includes(storeName)) {
            const shorter = Math.min(needle.length, storeName.length);
            const longer = Math.max(needle.length, storeName.length);
            const score = shorter / longer;

            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { item: storeItem, score, matchType: 'fuzzy' };
            }
            continue;
        }

        // Word-level overlap: "chicken breast" matches "chicken thigh" partially
        const needleWords = new Set(needle.split(/\s+/));
        const storeWords = new Set(storeName.split(/\s+/));
        const overlap = [...needleWords].filter((w) => storeWords.has(w)).length;
        if (overlap > 0) {
            const score = (overlap / Math.max(needleWords.size, storeWords.size)) * 0.8;
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { item: storeItem, score, matchType: 'fuzzy' };
            }
        }
    }

    // Only return fuzzy matches above threshold
    if (bestMatch && bestMatch.score >= 0.4) return bestMatch;
    return null;
}

// ── Provisioning Calculator ────────────────────────────────────────────────

const PROVISION_TABLE = 'passage_provisions';

/**
 * Calculate provisions for an entire meal plan.
 * Compares scaled recipe ingredients against Ship's Stores.
 */
export function calculateProvisions(
    plan: GalleyPlan,
    crewCount: number,
    passageName: string = 'Unnamed Passage',
): ProvisionSummary {
    // Get all store items
    const storeItems = getAll<StoresItem>('inventory_items');

    // Aggregate all ingredients across all days with scaling
    const aggregated = new Map<
        string,
        {
            ingredient: RecipeIngredient;
            totalRequired: number;
            recipeTitle: string;
        }
    >();

    for (const day of plan.days) {
        for (const meal of day.meals) {
            for (const ing of meal.ingredients || []) {
                const key = `${ing.name.toLowerCase()}_${ing.unit.toLowerCase()}`;
                const scaled = scaleIngredient(ing.amount, ing.scalable, meal.servings, crewCount);

                const existing = aggregated.get(key);
                if (existing) {
                    existing.totalRequired += scaled;
                } else {
                    aggregated.set(key, {
                        ingredient: ing,
                        totalRequired: scaled,
                        recipeTitle: meal.title,
                    });
                }
            }
        }
    }

    // Match against stores and calculate shortfalls
    const items: ProvisionItem[] = [];
    let matched = 0;
    let shortfalls = 0;
    let fullyStocked = 0;

    for (const [, entry] of aggregated) {
        const { ingredient, totalRequired, recipeTitle } = entry;
        const match = findStoreMatch(ingredient.name, storeItems);

        const onHand = match ? match.item.quantity : 0;
        const shortfall = Math.max(0, totalRequired - onHand);

        if (match) matched++;
        if (shortfall > 0) shortfalls++;
        else fullyStocked++;

        items.push({
            id: generateUUID(),
            passage_name: passageName,
            recipe_title: recipeTitle,
            ingredient_name: ingredient.name,
            required_qty: Math.round(totalRequired * 10) / 10,
            unit: ingredient.unit,
            scalable: ingredient.scalable,
            store_item_id: match?.item.id || null,
            store_item_name: match?.item.item_name || null,
            on_hand_qty: onHand,
            shortfall_qty: Math.round(shortfall * 10) / 10,
            status: shortfall <= 0 ? 'have' : 'needed',
        });
    }

    // Sort: shortfalls first, then by ingredient name
    items.sort((a, b) => {
        if (a.status === 'needed' && b.status !== 'needed') return -1;
        if (a.status !== 'needed' && b.status === 'needed') return 1;
        return a.ingredient_name.localeCompare(b.ingredient_name);
    });

    return {
        totalIngredients: items.length,
        matched,
        shortfalls,
        fullyStocked,
        items,
    };
}

/**
 * Persist provision items to LocalDatabase for offline tracking.
 */
export async function saveProvisions(items: ProvisionItem[]): Promise<void> {
    for (const item of items) {
        await insertLocal(PROVISION_TABLE, {
            ...item,
            created_at: new Date().toISOString(),
        });
    }
}

/**
 * Get saved provisions for a passage.
 */
export function getProvisions(passageName?: string): ProvisionItem[] {
    if (passageName) {
        return query<ProvisionItem>(PROVISION_TABLE, (p) => p.passage_name === passageName);
    }
    return getAll<ProvisionItem>(PROVISION_TABLE);
}
