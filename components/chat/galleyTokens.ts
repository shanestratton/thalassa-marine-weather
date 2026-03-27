/**
 * galleyTokens — Shared constants for galley components.
 *
 * Single source of truth for zone emojis, aisle emojis,
 * slot configuration, and ingredient helpers.
 */
import type { MealSlot } from '../../services/MealPlanService';

// ── Zone emojis (shopping list market zones) ──
export const ZONE_EMOJI: Record<string, string> = {
    Butcher: '🥩',
    Produce: '🥬',
    'Bottle Shop': '🍷',
    Bakery: '🥖',
    Dairy: '🧀',
    Chandlery: '⚓',
    'Fuel Dock': '⛽',
    Pharmacy: '💊',
    General: '🛒',
};

// ── Aisle / ingredient category emojis ──
export const AISLE_EMOJI: Record<string, string> = {
    meat: '🥩',
    produce: '🥬',
    dairy: '🧈',
    spices: '🧂',
    bakery: '🍞',
    'canned goods': '🥫',
    frozen: '🧊',
    seafood: '🐟',
    condiments: '🫙',
    beverages: '🍺',
    baking: '🧁',
};

export function getIngredientEmoji(aisle: string): string {
    const lower = aisle.toLowerCase();
    for (const [key, emoji] of Object.entries(AISLE_EMOJI)) {
        if (lower.includes(key)) return emoji;
    }
    return '📦';
}

// ── Storage location mapping from aisle ──
export function getStorageLocation(aisle: string): string {
    const lower = aisle.toLowerCase();
    if (lower.includes('meat') || lower.includes('seafood') || lower.includes('frozen')) return 'Freezer 1';
    if (lower.includes('dairy') || lower.includes('produce')) return 'Fridge';
    if (lower.includes('spice') || lower.includes('baking') || lower.includes('condiment')) return 'Pantry';
    if (lower.includes('canned') || lower.includes('beverage')) return 'Dry Locker 2';
    return 'Galley';
}

// ── Meal slot configuration ──
export const SLOT_CONFIG: { slot: MealSlot; label: string; emoji: string }[] = [
    { slot: 'breakfast', label: 'Brekky', emoji: '🌅' },
    { slot: 'lunch', label: 'Lunch', emoji: '☀️' },
    { slot: 'dinner', label: 'Dinner', emoji: '🌙' },
];

// ── Fuzzy match strip words (shared between ChefPlate and provision logic) ──
export const STRIP_WORDS = new Set([
    'large',
    'small',
    'medium',
    'fresh',
    'dried',
    'ground',
    'whole',
    'raw',
    'cooked',
    'chopped',
    'diced',
    'sliced',
    'minced',
    'grated',
    'shredded',
    'crushed',
    'melted',
    'softened',
    'unsalted',
    'salted',
    'sharp',
    'mild',
    'extra',
    'fine',
    'thick',
    'thin',
    'hot',
    'cold',
    'frozen',
    'canned',
    'tinned',
]);
