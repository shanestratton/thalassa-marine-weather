/**
 * Line icons for the Grocery list's aisles (132-B17).
 *
 * The list wore the emoji map in components/chat/galleyTokens (🥩 🥬 🍷 ⚓),
 * colour glyphs that render differently on every OS beside the app's stroke
 * icons, as Ship's Stores did before its categoryIcons. The aisle's name
 * always sits beside its icon, so close aisles may share a glyph (the food
 * counters), as Stores' Pantry and Provisions do.
 */
import type React from 'react';
import type { MarketZone } from '../../services/ShoppingListService';
import { AnchorIcon, CartIcon, DropletIcon, FoodIcon, FuelIcon, PlusSquareIcon, ThermometerIcon } from '../Icons';

/** A stroke icon from components/icons; each one is aria-hidden. */
export type GroceryZoneIcon = (props: { className?: string }) => React.JSX.Element;

export const GROCERY_ZONE_ICONS: Record<MarketZone, GroceryZoneIcon> = {
    Butcher: FoodIcon,
    Produce: FoodIcon,
    Bakery: FoodIcon,
    // Kept cold, as Stores' Fridge.
    Dairy: ThermometerIcon,
    'Bottle Shop': DropletIcon,
    Chandlery: AnchorIcon,
    'Fuel Dock': FuelIcon,
    // Stores' Medical.
    Pharmacy: PlusSquareIcon,
    General: CartIcon,
};

/** The icon for an aisle, with a cart for one this build does not know. */
export const groceryZoneIcon = (zone: string): GroceryZoneIcon => GROCERY_ZONE_ICONS[zone as MarketZone] ?? CartIcon;
