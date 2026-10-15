/**
 * The small tag on a Stores row the Grocery List made (131-B14), in place of
 * the 'Added from Grocery List purchase <id>' line its notes used to show.
 */
import React from 'react';
import { GROCERY_CHIP, type GroceryProvenance } from '../../../services/vessel/storesProvenance';

export const GroceryChip: React.FC<{ kind: GroceryProvenance; className?: string }> = ({ kind, className = '' }) => (
    <span
        className={`inline-flex w-fit items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-px text-[11px] font-bold text-emerald-300 ${className}`}
    >
        {GROCERY_CHIP[kind]}
    </span>
);
