/**
 * SubcategoryMenu — drills into a selected top-level category and
 * shows the subcategories (e.g. Technology → Screens / Pi
 * Accessories / Sensors). Tapping a subcategory enters the
 * ProductDetail swipe view starting at the first product in that
 * subcategory.
 *
 * Each subcategory tile shows the product count so it's clear how
 * many items will be in the swipe deck.
 */
import React from 'react';
import type { ChandleryCategory, ChandlerySubcategory } from '../../data/chandleryCategories';
import { productsForSubcategory } from '../../data/storeOne.products';
import { triggerHaptic } from '../../utils/system';

interface SubcategoryMenuProps {
    category: ChandleryCategory;
    onBack: () => void;
    onSelectSubcategory: (sub: ChandlerySubcategory) => void;
    onOpenBasket: () => void;
    basketCount: number;
}

export const SubcategoryMenu: React.FC<SubcategoryMenuProps> = ({
    category,
    onBack,
    onSelectSubcategory,
    onOpenBasket,
    basketCount,
}) => {
    return (
        <div className="h-full overflow-y-auto px-4 pt-3 pb-24">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
                <button
                    type="button"
                    onClick={() => {
                        triggerHaptic('light');
                        onBack();
                    }}
                    className="text-sm font-bold text-sky-400 hover:text-sky-300 -ml-2 px-2 py-1"
                    aria-label="Back to categories"
                >
                    ← Categories
                </button>
                <button
                    type="button"
                    onClick={onOpenBasket}
                    aria-label={`Open basket (${basketCount} item${basketCount === 1 ? '' : 's'})`}
                    className="relative w-10 h-10 rounded-full bg-white/[0.04] border border-white/10 active:scale-95 transition-all flex items-center justify-center"
                >
                    <span>🧺</span>
                    {basketCount > 0 && (
                        <span className="absolute -top-1 -right-1 bg-sky-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                            {basketCount}
                        </span>
                    )}
                </button>
            </div>

            {/* Category badge + title */}
            <div className="mb-6">
                <div className="text-4xl mb-2">{category.icon}</div>
                <h1 className="text-2xl font-black text-white tracking-tight">{category.label}</h1>
                <p className="text-xs text-slate-400 mt-1">{category.blurb}</p>
            </div>

            {/* Subcategory list — vertical so labels can breathe */}
            <div className="space-y-2.5">
                {category.subcategories.map((sub) => {
                    const products = productsForSubcategory(category.id, sub.id);
                    return (
                        <button
                            key={sub.id}
                            type="button"
                            disabled={products.length === 0}
                            onClick={() => {
                                triggerHaptic('light');
                                onSelectSubcategory(sub);
                            }}
                            className={`w-full rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04] active:scale-[0.99] transition-all p-4 flex items-center gap-3 text-left ${
                                products.length === 0 ? 'opacity-50' : ''
                            }`}
                            aria-label={`Browse ${sub.label} (${products.length} ${products.length === 1 ? 'product' : 'products'})`}
                        >
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-white">{sub.label}</div>
                                {sub.blurb && (
                                    <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{sub.blurb}</div>
                                )}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider font-bold text-sky-300/70 shrink-0">
                                {products.length === 0
                                    ? 'Empty'
                                    : `${products.length} item${products.length === 1 ? '' : 's'}`}
                            </div>
                            {products.length > 0 && (
                                <svg
                                    className="w-4 h-4 text-sky-300/70 shrink-0"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M9 5l7 7-7 7" />
                                </svg>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
