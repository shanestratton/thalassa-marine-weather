/**
 * CategoryMenu — top-level entry for the chandlery.
 *
 * Renders a tile grid of top-level categories (Technology, Winches,
 * Sails, …). Tappable tiles open the SubcategoryMenu; placeholder
 * categories (no products yet) render a "Coming soon" treatment and
 * a tap does nothing but a haptic.
 */
import React from 'react';
import { CHANDLERY_CATEGORIES, type ChandleryCategory } from '../../data/chandleryCategories';
import { triggerHaptic } from '../../utils/system';

interface CategoryMenuProps {
    onSelectCategory: (category: ChandleryCategory) => void;
    onOpenBasket: () => void;
    basketCount: number;
    onSwitchToCommunity: () => void;
}

export const CategoryMenu: React.FC<CategoryMenuProps> = ({
    onSelectCategory,
    onOpenBasket,
    basketCount,
    onSwitchToCommunity,
}) => {
    return (
        <div className="h-full overflow-y-auto px-4 pt-3 pb-24">
            {/* Header band — chandlery brand + basket badge */}
            <div className="flex items-center justify-between mb-6 pt-2">
                <div>
                    <h1 className="text-3xl font-black text-white tracking-tight">Chandlery</h1>
                    <p className="text-xs text-slate-400 mt-1">Curated gear, vetted for your vessel.</p>
                </div>
                <button
                    type="button"
                    onClick={onOpenBasket}
                    aria-label={`Open basket (${basketCount} item${basketCount === 1 ? '' : 's'})`}
                    className="relative w-12 h-12 rounded-full bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] active:scale-95 transition-all flex items-center justify-center"
                >
                    <span className="text-xl">🧺</span>
                    {basketCount > 0 && (
                        <span className="absolute -top-1 -right-1 bg-sky-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                            {basketCount}
                        </span>
                    )}
                </button>
            </div>

            {/* Category tiles */}
            <div className="grid grid-cols-2 gap-3">
                {CHANDLERY_CATEGORIES.map((cat) => (
                    <CategoryTile key={cat.id} category={cat} onSelect={onSelectCategory} />
                ))}
            </div>

            {/* Community marketplace link — kept from the old chandlery */}
            <button
                type="button"
                onClick={onSwitchToCommunity}
                className="mt-8 w-full text-center py-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] active:scale-[0.99] transition-all"
            >
                <span className="text-xs text-slate-400">
                    Looking for used gear?{' '}
                    <span className="text-sky-400 font-bold">Browse the Community Marketplace →</span>
                </span>
            </button>
        </div>
    );
};

const CategoryTile: React.FC<{
    category: ChandleryCategory;
    onSelect: (c: ChandleryCategory) => void;
}> = ({ category, onSelect }) => {
    const handleTap = () => {
        triggerHaptic('light');
        if (!category.placeholder) onSelect(category);
    };

    if (category.placeholder) {
        return (
            <button
                type="button"
                onClick={handleTap}
                className="aspect-square rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 flex flex-col justify-between opacity-50 cursor-default"
                aria-label={`${category.label} category — coming soon`}
            >
                <div className="text-3xl opacity-80">{category.icon}</div>
                <div className="text-left">
                    <div className="text-sm font-bold text-white">{category.label}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">Coming soon</div>
                </div>
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={handleTap}
            className="aspect-square rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/10 to-cyan-500/[0.04] hover:from-sky-500/15 hover:to-cyan-500/[0.06] active:scale-[0.97] transition-all p-4 flex flex-col justify-between"
            aria-label={`Open ${category.label} category`}
        >
            <div className="text-3xl">{category.icon}</div>
            <div className="text-left">
                <div className="text-sm font-bold text-white">{category.label}</div>
                <div className="text-[10px] text-sky-300/70 mt-0.5 line-clamp-1">{category.blurb}</div>
            </div>
        </button>
    );
};
