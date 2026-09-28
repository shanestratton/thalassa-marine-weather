import React from 'react';
import { INVENTORY_CATEGORIES, type InventoryCategory } from '../../../types';
import { storesCategoryIcon } from './categoryIcons';

/** Fifteen categories, three across and five down. Stack the icon above the
 * wrapping label so the same grid stays readable in a narrow phone sheet. */
export const StoresCategoryGrid: React.FC<{
    value: InventoryCategory;
    onChange: (category: InventoryCategory) => void;
}> = ({ value, onChange }) => (
    <div role="group" aria-label="Store category" className="grid grid-cols-3 gap-1 mt-0.5 sm:gap-1.5">
        {INVENTORY_CATEGORIES.map((category) => {
            const CategoryIcon = storesCategoryIcon(category);
            return (
                <button
                    key={category}
                    type="button"
                    aria-label={category}
                    aria-pressed={value === category}
                    onClick={() => onChange(category)}
                    className={`flex min-w-0 min-h-[56px] flex-col items-center justify-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px] sm:text-xs leading-tight font-bold text-center transition-all ${
                        value === category
                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                            : 'bg-white/5 text-gray-400 border border-white/5'
                    }`}
                >
                    <CategoryIcon className="h-4 w-4 shrink-0" />
                    <span className="w-full min-w-0 text-balance [overflow-wrap:anywhere]">{category}</span>
                </button>
            );
        })}
    </div>
);
