/**
 * Line icons for the Ship's Stores categories.
 *
 * The stores used the emoji map in types/vessel.ts (⚙️ 🔧 ⚡ 🥫 🧊 …), which
 * rendered as OS-varying colour glyphs beside the app's stroke icons (UX
 * scorecard run 7). The label always sits beside the icon, so a shared
 * glyph for close categories (Pantry, Provisions) is fine.
 */
import type React from 'react';
import type { StoresCategory } from '../../../types';
import {
    AnchorIcon,
    FoodIcon,
    GearIcon,
    LifeBuoyIcon,
    LightningBoltIcon,
    PackageIcon,
    PlusSquareIcon,
    SailBoatIcon,
    SparklesIcon,
    ThermometerIcon,
    DropletIcon,
} from '../../Icons';

/** A stroke icon from components/icons; each one is aria-hidden. */
export type StoresCategoryIcon = (props: { className?: string }) => React.JSX.Element;

export const STORES_CATEGORY_LINE_ICONS: Record<StoresCategory, StoresCategoryIcon> = {
    Engine: GearIcon,
    Plumbing: DropletIcon,
    Electrical: LightningBoltIcon,
    Rigging: SailBoatIcon,
    Safety: LifeBuoyIcon,
    Provisions: FoodIcon,
    Medical: PlusSquareIcon,
    Misc: PackageIcon,
    Pantry: FoodIcon,
    Freezer: ThermometerIcon,
    Fridge: ThermometerIcon,
    Dry: PackageIcon,
    Booze: FoodIcon,
    Deck: AnchorIcon,
    Cleaning: SparklesIcon,
};

/** The icon for a category, with a box for one this build does not know. */
export const storesCategoryIcon = (category: StoresCategory): StoresCategoryIcon =>
    STORES_CATEGORY_LINE_ICONS[category] ?? PackageIcon;
