/**
 * The aisle a grocery item is found in, from its name (132-B17, binder audit
 * GAL-15). Its own module, with no imports, so the Grocery list's Add form can
 * light the aisle as a sailor types ('Eggplant' → Produce) without the
 * shopping-list service, and a test of that form checks the real words.
 * ShoppingListService re-exports both, so its callers are unchanged.
 */

export type MarketZone =
    | 'Butcher'
    | 'Produce'
    | 'Bottle Shop'
    | 'Bakery'
    | 'Dairy'
    | 'Chandlery'
    | 'Fuel Dock'
    | 'Pharmacy'
    | 'General';

/**
 * The words that put an item in an aisle, matched as whole words, singular or
 * plural (132-B17, binder audit GAL-15). A bare substring sent 'Extra virgin
 * olive oil' to the Bottle Shop ('gin'), breadcrumbs too ('rum'), eggplant to
 * Dairy ('egg') and toilet roll to the Bakery ('roll'). The longest word that
 * matches wins, so 'Methylated spirits' is fuel, not a spirit; a tie goes to
 * the aisle listed first.
 */
const ZONE_KEYWORDS: Record<MarketZone, string[]> = {
    Butcher: [
        'beef',
        'chicken',
        'pork',
        'lamb',
        'sausage',
        'mince',
        'steak',
        'brisket',
        'bacon',
        'ham',
        'turkey',
        'veal',
        'meat',
        'fish',
        'prawn',
        'shrimp',
        'crab',
        'lobster',
        'salmon',
        'tuna',
        'snapper',
    ],
    Produce: [
        'onion',
        'garlic',
        'tomato',
        'potato',
        'carrot',
        'lettuce',
        'spinach',
        'capsicum',
        'pepper',
        'mushroom',
        'broccoli',
        'corn',
        'avocado',
        'lime',
        'lemon',
        'apple',
        'pineapple',
        'banana',
        'orange',
        'mango',
        'herb',
        'basil',
        'parsley',
        'cilantro',
        'coriander',
        'ginger',
        'chilli',
        'eggplant',
        'aubergine',
        'zucchini',
        'cucumber',
        'pumpkin',
        'cabbage',
        'celery',
    ],
    'Bottle Shop': [
        'wine',
        'beer',
        'rum',
        'vodka',
        'whisky',
        'whiskey',
        'gin',
        'tequila',
        'champagne',
        'prosecco',
        'cider',
        'spirit',
        'liqueur',
        'bourbon',
    ],
    Bakery: ['bread', 'breadcrumb', 'roll', 'bun', 'baguette', 'croissant', 'flour', 'yeast', 'pastry'],
    Dairy: ['milk', 'cheese', 'butter', 'cream', 'yoghurt', 'yogurt', 'egg'],
    Chandlery: [
        'rope',
        'shackle',
        'snatch block',
        'sail',
        'tape',
        'epoxy',
        'antifoul',
        'winch',
        'grease',
        'filter',
        'impeller',
        'zinc',
        'anode',
        'fuse',
        'white spirit',
        'fishing',
    ],
    'Fuel Dock': ['diesel', 'petrol', 'gas', 'propane', 'lpg', 'fuel', 'methylated', 'metho'],
    Pharmacy: [
        'paracetamol',
        'ibuprofen',
        'bandage',
        'antiseptic',
        'sunscreen',
        'zinc cream',
        'seasick',
        'dramamine',
        'antihistamine',
    ],
    General: [],
};

/**
 * Pantry and household things whose names carry another aisle's word:
 * peanut butter is not dairy, fish sauce is not at the butcher, a toilet roll
 * is not bread. Checked before the aisles.
 */
const GENERAL_PHRASES = [
    'peanut butter',
    'coconut milk',
    'coconut cream',
    'cream of tartar',
    'black pepper',
    'stock',
    'sauce',
    'vinegar',
    'powder',
    'tinned',
    'canned',
    'noodle',
    'ginger beer',
    'toilet roll',
    'toilet paper',
    'kitchen roll',
    'paper towel',
    'coffee filter',
];

/** A name's words, lower case and without accents: 'Jalapeño chillies' → ['jalapeno', 'chillies']. */
function nameWords(name: string): string[] {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** One word against a keyword's word, in either number: egg/eggs, tomato/tomatoes, berry/berries. */
function sameWord(word: string, keyword: string): boolean {
    return (
        word === keyword ||
        word === `${keyword}s` ||
        word === `${keyword}es` ||
        (keyword.endsWith('y') && word === `${keyword.slice(0, -1)}ies`)
    );
}

/** Whether the words hold the phrase, word for word, the last word in either number. */
function holdsPhrase(words: string[], phrase: string): boolean {
    const wanted = phrase.split(' ');
    for (let start = 0; start + wanted.length <= words.length; start++) {
        if (
            wanted.every((part, i) =>
                i === wanted.length - 1 ? sameWord(words[start + i], part) : words[start + i] === part,
            )
        ) {
            return true;
        }
    }
    return false;
}

/** The aisle an item is found in, from its name; General when nothing says. */
export function detectMarketZone(ingredientName: string): MarketZone {
    const words = nameWords(ingredientName);
    if (GENERAL_PHRASES.some((phrase) => holdsPhrase(words, phrase))) return 'General';
    let best: { zone: MarketZone; length: number } | null = null;
    for (const [zone, keywords] of Object.entries(ZONE_KEYWORDS) as [MarketZone, string[]][]) {
        for (const keyword of keywords) {
            if (keyword.length > (best?.length ?? 0) && holdsPhrase(words, keyword)) {
                best = { zone, length: keyword.length };
            }
        }
    }
    return best?.zone ?? 'General';
}
