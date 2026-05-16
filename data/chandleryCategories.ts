/**
 * Chandlery category structure — top-level navigation and subcategory
 * groupings for the curated storefront.
 *
 * Categories with `placeholder: true` show a "Coming soon" treatment on
 * the top-level menu. Populate them by adding products to
 * storeOne.products.ts with the matching categoryId / subcategoryId,
 * then flip `placeholder` to false when at least one subcategory has
 * stock.
 *
 * Subcategory IDs are scoped within a category (so 'screens' under
 * 'technology' is distinct from a hypothetical 'screens' under
 * another category). Products reference the pair { categoryId,
 * subcategoryId } to slot in.
 */

export interface ChandlerySubcategory {
    id: string;
    label: string;
    /** Short blurb for the subcategory tile. Plain text. */
    blurb?: string;
}

export interface ChandleryCategory {
    id: string;
    label: string;
    /** Emoji icon for the menu tile. Easy to swap to a real icon later. */
    icon: string;
    /** One-line teaser shown on the top-level menu. */
    blurb: string;
    /** True if this category has no stock yet — tile renders as "Coming soon". */
    placeholder: boolean;
    subcategories: ChandlerySubcategory[];
}

export const CHANDLERY_CATEGORIES: ChandleryCategory[] = [
    {
        id: 'technology',
        label: 'Technology',
        icon: '⚡',
        blurb: 'Pi accessories, screens, sensors',
        placeholder: false,
        subcategories: [
            { id: 'screens', label: 'Screens', blurb: 'Cockpit-grade displays' },
            { id: 'pi-accessories', label: 'Pi Accessories', blurb: 'Hats and bridges for the Thalassa Pi' },
            { id: 'sensors', label: 'Sensors', blurb: 'Wind, depth, environment' },
        ],
    },
    {
        id: 'winches',
        label: 'Winches',
        icon: '⚓',
        blurb: 'Lewmar, Andersen, Harken',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'sails',
        label: 'Sails',
        icon: '⛵',
        blurb: 'Cruising, racing, storm',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'hardware',
        label: 'Hardware',
        icon: '🔩',
        blurb: 'Blocks, cleats, fittings',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'safety',
        label: 'Safety',
        icon: '🛟',
        blurb: 'PFDs, EPIRBs, flares',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'electrical',
        label: 'Electrical',
        icon: '🔌',
        blurb: 'Batteries, chargers, switches',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'ground-tackle',
        label: 'Ground Tackle',
        icon: '🪨',
        blurb: 'Anchors, chain, rode',
        placeholder: true,
        subcategories: [],
    },
    {
        id: 'galley',
        label: 'Galley',
        icon: '🍳',
        blurb: 'Stoves, fridges, cookware',
        placeholder: true,
        subcategories: [],
    },
];

/** Find a category by id. Returns undefined for unknown IDs. */
export function getCategory(id: string): ChandleryCategory | undefined {
    return CHANDLERY_CATEGORIES.find((c) => c.id === id);
}

/** Find a subcategory within a category. */
export function getSubcategory(categoryId: string, subcategoryId: string): ChandlerySubcategory | undefined {
    return getCategory(categoryId)?.subcategories.find((s) => s.id === subcategoryId);
}
