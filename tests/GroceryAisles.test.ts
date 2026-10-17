/**
 * Aisles by whole words (132-B17, binder audit GAL-15).
 *
 * detectMarketZone matched a bare substring, so 'Extra virgin olive oil' went
 * to the Bottle Shop ('gin'), breadcrumbs too ('rum'), eggplant to Dairy
 * ('egg') and toilet roll to the Bakery ('roll'). It now matches whole words,
 * singular or plural, the longest word wins, and pantry and household phrases
 * that carry another aisle's word stay in General. Every name is a fictional
 * galley's shopping, nothing real.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/vessel/SyncService', () => ({ syncNow: vi.fn().mockResolvedValue(undefined) }));

import { detectMarketZone, type MarketZone } from '../services/ShoppingListService';

const cases = (rows: [string, MarketZone][]) =>
    it.each(rows)('%s → %s', (name, zone) => expect(detectMarketZone(name)).toBe(zone));

describe('the audit cases (GAL-15) no longer land in the wrong aisle', () => {
    cases([
        ['Extra virgin olive oil', 'General'],
        ['Breadcrumbs', 'Bakery'],
        ['Panko breadcrumbs', 'Bakery'],
        ['Eggplant', 'Produce'],
        ['Toilet roll', 'General'],
        ['Toilet rolls (12 pack)', 'General'],
    ]);
});

describe('whole words only', () => {
    cases([
        // 'gin' in virgin, 'rum' in crumbs, 'ham' in hamburger, 'egg' in eggplant
        ['Virgin coconut oil', 'General'],
        ['Hamburger buns', 'Bakery'],
        ['Fishing line 20 kg', 'Chandlery'],
        ['Pineapple', 'Produce'],
        ['Gin', 'Bottle Shop'],
        ['Dark rum', 'Bottle Shop'],
        ['Leg ham', 'Butcher'],
    ]);
});

describe('singular or plural, any case, accents and punctuation aside', () => {
    cases([
        ['Tomatoes', 'Produce'],
        ['POTATOES', 'Produce'],
        ['Free-range eggs', 'Dairy'],
        ['Bread rolls', 'Bakery'],
        ['Jalapeño chillies', 'Produce'],
        ['Raw-water impeller', 'Chandlery'],
    ]);
});

describe('the longest word wins; a tie goes to the aisle listed first', () => {
    cases([
        // 'methylated' (fuel for the stove) over 'spirit'
        ['Methylated spirits', 'Fuel Dock'],
        // 'white spirit' (a solvent) over 'spirit'
        ['White spirit', 'Chandlery'],
        // 'filter' (a part) over 'fuel'
        ['Fuel filter', 'Chandlery'],
        // 'zinc cream' (sun cream) over 'zinc' (an anode) and 'cream'
        ['Zinc cream', 'Pharmacy'],
        ['Diesel fuel', 'Fuel Dock'],
        ['Beef steak', 'Butcher'],
    ]);
});

describe("pantry and household things that carry another aisle's word stay in General", () => {
    cases([
        ['Peanut butter', 'General'],
        ['Coconut milk', 'General'],
        ['Coconut cream', 'General'],
        ['Fish sauce', 'General'],
        ['Chicken stock', 'General'],
        ['Black pepper', 'General'],
        ['Red wine vinegar', 'General'],
        ['Apple cider vinegar', 'General'],
        ['Tinned tomatoes', 'General'],
        ['Garlic powder', 'General'],
        ['Egg noodles', 'General'],
        ['Ginger beer', 'General'],
        ['Paper towels', 'General'],
        ['Coffee filters', 'General'],
    ]);
});

describe('what already sorted right still does', () => {
    cases([
        ['Chicken breast', 'Butcher'],
        ['Garlic', 'Produce'],
        ['Red wine', 'Bottle Shop'],
        ['Butter', 'Dairy'],
        ['Rope 12mm', 'Chandlery'],
        ['Paracetamol', 'Pharmacy'],
        ['Ginger', 'Produce'],
        ['Red capsicum', 'Produce'],
        ['Salt', 'General'],
        ['Dish soap', 'General'],
        ['', 'General'],
    ]);
});
