/**
 * ChandleryPage — view router for the curated chandlery.
 *
 * Flow (new design, May 2026):
 *   1. Categories       (top-level menu, e.g. Technology / Winches)
 *   2. Subcategories    (e.g. Technology → Screens / Pi Accessories / Sensors)
 *   3. Product detail   (one item per page, swipe left/right between items,
 *                        Add to Basket button)
 *   4. Basket drawer    (modal sheet, qty steppers, checkout)
 *
 * Community Marketplace (peer-to-peer used gear) remains reachable via a
 * discreet link on the categories screen, opening the legacy MarketplacePage.
 *
 * Aesthetic brief carried over from prior rev: "1stDibs / Aesop / Apple
 * Store" — quiet luxury, restrained typography, image-forward, dark mode.
 */
import React, { useCallback, useState } from 'react';
import { CHANDLERY_CATEGORIES, type ChandleryCategory, type ChandlerySubcategory } from '../data/chandleryCategories';
import { productsForSubcategory } from '../data/storeOne.products';
import { useChandleryBasket } from '../hooks/useChandleryBasket';
import { lazyRetry } from '../utils/lazyRetry';
import { CategoryMenu } from './chandlery/CategoryMenu';
import { SubcategoryMenu } from './chandlery/SubcategoryMenu';
import { ProductDetail } from './chandlery/ProductDetail';
import { BasketDrawer } from './chandlery/BasketDrawer';

const MarketplacePage = lazyRetry(
    () => import('./MarketplacePage').then((m) => ({ default: m.MarketplacePage })),
    'MarketplacePage_FromChandlery',
);

interface ChandleryPageProps {
    onBack: () => void;
    onOpenDM?: (
        sellerId: string,
        sellerName: string,
        listingContext?: { title: string; price: string; image?: string },
    ) => void;
}

type View =
    | { kind: 'categories' }
    | { kind: 'subcategories'; category: ChandleryCategory }
    | { kind: 'detail'; category: ChandleryCategory; subcategory: ChandlerySubcategory; startIndex: number }
    | { kind: 'community' };

export const ChandleryPage: React.FC<ChandleryPageProps> = ({ onBack: _onBack, onOpenDM }) => {
    const [view, setView] = useState<View>({ kind: 'categories' });
    const [basketOpen, setBasketOpen] = useState(false);
    const { lines, count } = useChandleryBasket();

    const openBasket = useCallback(() => setBasketOpen(true), []);
    const closeBasket = useCallback(() => setBasketOpen(false), []);

    const handleSelectCategory = useCallback((category: ChandleryCategory) => {
        // Skip the subcategory step when there's only one populated
        // sub — jump directly into the product deck. Smoother UX
        // for narrow categories.
        const realSubs = category.subcategories.filter((s) => productsForSubcategory(category.id, s.id).length > 0);
        if (realSubs.length === 1) {
            setView({ kind: 'detail', category, subcategory: realSubs[0], startIndex: 0 });
            return;
        }
        setView({ kind: 'subcategories', category });
    }, []);

    const handleSelectSubcategory = useCallback((category: ChandleryCategory, subcategory: ChandlerySubcategory) => {
        setView({ kind: 'detail', category, subcategory, startIndex: 0 });
    }, []);

    const backToCategories = useCallback(() => setView({ kind: 'categories' }), []);
    const backToSubcategories = useCallback(
        (category: ChandleryCategory) => setView({ kind: 'subcategories', category }),
        [],
    );

    // ── Community marketplace branch (peer-to-peer) ──
    if (view.kind === 'community') {
        return <MarketplacePage onBack={backToCategories} onOpenDM={onOpenDM} />;
    }

    // ── Main flow ──
    return (
        <div className="relative flex-1 flex flex-col bg-slate-950 overflow-hidden">
            {view.kind === 'categories' && (
                <CategoryMenu
                    onSelectCategory={handleSelectCategory}
                    onOpenBasket={openBasket}
                    basketCount={count}
                    onSwitchToCommunity={() => setView({ kind: 'community' })}
                />
            )}
            {view.kind === 'subcategories' && (
                <SubcategoryMenu
                    category={view.category}
                    onBack={backToCategories}
                    onSelectSubcategory={(sub) => handleSelectSubcategory(view.category, sub)}
                    onOpenBasket={openBasket}
                    basketCount={count}
                />
            )}
            {view.kind === 'detail' && (
                <ProductDetail
                    products={productsForSubcategory(view.category.id, view.subcategory.id)}
                    startIndex={view.startIndex}
                    category={view.category}
                    subcategory={view.subcategory}
                    onBack={() => backToSubcategories(view.category)}
                    onOpenBasket={openBasket}
                    basketCount={count}
                />
            )}

            {/* Basket drawer is global to the chandlery — accessible from
                any of the three internal views. */}
            <BasketDrawer open={basketOpen} onClose={closeBasket} lines={lines} />
        </div>
    );
};

// Re-export for any external imports that referenced the old categories surface.
export { CHANDLERY_CATEGORIES };
