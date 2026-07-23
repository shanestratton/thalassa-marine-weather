/**
 * ProductDetail — single-product page with swipe-deck navigation.
 *
 * One item per page. Swipe LEFT to advance to the next product in
 * the subcategory; swipe RIGHT for the previous. Buttons mirror the
 * swipe for users who prefer taps. "Add to basket" lives at the
 * bottom; tapping it gives haptic feedback and bumps the basket
 * counter shown in the header.
 *
 * Touch handling is hand-rolled (no extra library) — onTouchStart
 * captures the X, onTouchEnd compares against a threshold to decide
 * whether to flip. Vertical scrolling is preserved by only treating
 * gestures as a swipe when |dx| > |dy| * 1.5.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { type StoreOneProduct } from '../../data/storeOne.products';
import type { ChandleryCategory, ChandlerySubcategory } from '../../data/chandleryCategories';
import { addToBasket } from '../../services/ChandleryBasketService';
import { triggerHaptic } from '../../utils/system';
import { useSettings } from '../../context/SettingsContext';
import { SafeImage } from '../ui/SafeImage';

interface ProductDetailProps {
    products: StoreOneProduct[];
    startIndex: number;
    category: ChandleryCategory;
    subcategory: ChandlerySubcategory;
    onBack: () => void;
    onOpenBasket: () => void;
    basketCount: number;
}

const SWIPE_THRESHOLD_PX = 50;

const PRODUCT_GRADIENT: Record<string, string> = {
    'copperhill-pican-m': 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
    'xenarc-703wp': 'linear-gradient(135deg, #020617 0%, #1e3a8a 100%)',
    'calypso-ultrasonic-portable-mini': 'linear-gradient(135deg, #334155 0%, #075985 100%)',
};

const getProductGradient = (id: string): string =>
    PRODUCT_GRADIENT[id] || 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';

export const ProductDetail: React.FC<ProductDetailProps> = ({
    products,
    startIndex,
    category,
    subcategory,
    onBack,
    onOpenBasket,
    basketCount,
}) => {
    const { settings } = useSettings();
    const [index, setIndex] = useState(() => Math.max(0, Math.min(startIndex, products.length - 1)));
    const [brokenImage, setBrokenImage] = useState<Set<string>>(new Set());
    const [adding, setAdding] = useState(false);
    const [justAdded, setJustAdded] = useState(false);
    const touchStartRef = useRef<{ x: number; y: number } | null>(null);
    const addedFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    const product = products[index] ?? null;
    const currentProductIdRef = useRef<string | null>(product?.id ?? null);
    currentProductIdRef.current = product?.id ?? null;

    const clearAddedFeedback = useCallback(() => {
        if (addedFeedbackTimerRef.current) {
            clearTimeout(addedFeedbackTimerRef.current);
            addedFeedbackTimerRef.current = null;
        }
        setJustAdded(false);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (addedFeedbackTimerRef.current) clearTimeout(addedFeedbackTimerRef.current);
        };
    }, []);

    // ── Swipe handlers ────────────────────────────────────────────
    const goPrev = useCallback(() => {
        if (index === 0) return;
        triggerHaptic('light');
        clearAddedFeedback();
        setIndex((i) => Math.max(0, i - 1));
    }, [clearAddedFeedback, index]);

    const goNext = useCallback(() => {
        if (index >= products.length - 1) return;
        triggerHaptic('light');
        clearAddedFeedback();
        setIndex((i) => Math.min(products.length - 1, i + 1));
    }, [clearAddedFeedback, index, products.length]);

    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0];
        touchStartRef.current = { x: t.clientX, y: t.clientY };
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        // Only count as a horizontal swipe if it's clearly horizontal
        // (otherwise we'd hijack scrolls).
        if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
        if (dx > 0) goPrev();
        else goNext();
    };

    // ── Add to basket ─────────────────────────────────────────────
    const handleAdd = useCallback(async () => {
        if (adding || !product) return;
        const productId = product.id;
        setAdding(true);
        triggerHaptic('medium');
        try {
            await addToBasket(productId, 1);
            if (!mountedRef.current || currentProductIdRef.current !== productId) return;
            if (addedFeedbackTimerRef.current) clearTimeout(addedFeedbackTimerRef.current);
            setJustAdded(true);
            addedFeedbackTimerRef.current = setTimeout(() => {
                setJustAdded(false);
                addedFeedbackTimerRef.current = null;
            }, 1500);
        } finally {
            if (mountedRef.current) setAdding(false);
        }
    }, [adding, product]);

    if (!product) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center" role="status">
                <span aria-hidden="true" className="text-4xl opacity-50">
                    {category.icon}
                </span>
                <div>
                    <h1 className="text-base font-bold text-white">No products available</h1>
                    <p className="mt-1 text-xs text-slate-400">This collection does not have any listed stock yet.</p>
                </div>
                <button
                    type="button"
                    onClick={onBack}
                    className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-bold text-sky-300"
                >
                    Back to {subcategory.label}
                </button>
            </div>
        );
    }

    // ── Vessel-aware compatibility note ──────────────────────────
    const vessel = settings.vessel;
    const isObserver = vessel?.type === 'observer';
    const hasVessel = !!vessel && !isObserver;
    let compatibilityLabel = 'Portable · works on any vessel';
    let compatibilityOk = true;
    if (product.requires_12v) {
        if (hasVessel) {
            compatibilityLabel = `Compatible with ${vessel?.name || 'your vessel'}`;
        } else {
            compatibilityLabel = 'Requires a vessel with 12V or NMEA 2000 power';
            compatibilityOk = false;
        }
    }

    return (
        <div className="h-full flex flex-col" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <button
                    type="button"
                    onClick={() => {
                        triggerHaptic('light');
                        onBack();
                    }}
                    className="text-sm font-bold text-sky-400 hover:text-sky-300 -ml-2 px-2 py-1"
                    aria-label={`Back to ${subcategory.label}`}
                >
                    ← {subcategory.label}
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

            {/* Body — one item per page */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-32">
                {/* Hero image */}
                <div
                    className="aspect-square rounded-2xl overflow-hidden mb-5 flex items-center justify-center"
                    style={{ background: getProductGradient(product.id) }}
                >
                    {product.imageUrl && !brokenImage.has(product.id) ? (
                        <SafeImage
                            src={product.imageUrl}
                            alt={product.name}
                            className="w-full h-full object-contain"
                            onError={() => setBrokenImage((prev) => new Set(prev).add(product.id))}
                        />
                    ) : (
                        <span className="text-6xl opacity-30">{category.icon}</span>
                    )}
                </div>

                {/* Name + price */}
                <div className="mb-4">
                    <h1 className="text-2xl font-black text-white tracking-tight leading-tight">{product.name}</h1>
                    <div className="mt-2 text-3xl font-black text-sky-300">${product.price.toLocaleString()}</div>
                </div>

                {/* Compatibility note */}
                <div
                    className={`mb-5 rounded-xl border px-3 py-2.5 ${
                        compatibilityOk
                            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                            : 'border-amber-500/25 bg-amber-500/[0.06]'
                    }`}
                >
                    <div
                        className={`text-[10px] font-black uppercase tracking-[0.18em] mb-1 ${
                            compatibilityOk ? 'text-emerald-300/80' : 'text-amber-300/80'
                        }`}
                    >
                        {compatibilityOk ? '✓ Fits your boat' : '⚠ Heads up'}
                    </div>
                    <div className="text-xs text-white/90 leading-relaxed">{compatibilityLabel}</div>
                </div>

                {/* Description */}
                <p className="text-sm text-slate-300 leading-relaxed mb-5">{product.description}</p>

                {/* Specs */}
                <div className="mb-6">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.18em] mb-2">Specs</div>
                    <ul className="space-y-1.5">
                        {product.specs.map((spec, i) => (
                            <li key={i} className="flex gap-2 text-xs text-slate-300 leading-relaxed">
                                <span className="text-sky-400 shrink-0">·</span>
                                <span>{spec}</span>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Swipe affordance — only shown when there's more in the deck */}
                {products.length > 1 && (
                    <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                        <button
                            type="button"
                            onClick={goPrev}
                            disabled={index === 0}
                            className="flex items-center gap-1 active:scale-95 transition-transform disabled:opacity-30"
                            aria-label="Previous product"
                        >
                            ← Prev
                        </button>
                        <span className="font-mono text-slate-500">
                            {index + 1} / {products.length}
                        </span>
                        <button
                            type="button"
                            onClick={goNext}
                            disabled={index >= products.length - 1}
                            className="flex items-center gap-1 active:scale-95 transition-transform disabled:opacity-30"
                            aria-label="Next product"
                        >
                            Next →
                        </button>
                    </div>
                )}
            </div>

            {/* Sticky Add to basket */}
            <div className="absolute left-0 right-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+88px)] pt-3 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent pointer-events-none">
                <button
                    type="button"
                    onClick={() => void handleAdd()}
                    disabled={adding}
                    aria-label={`Add ${product.name} to basket`}
                    className={`pointer-events-auto w-full h-14 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.98] ${
                        justAdded
                            ? 'bg-emerald-500 text-white'
                            : 'bg-sky-500 hover:bg-sky-400 text-white disabled:opacity-50'
                    }`}
                >
                    {justAdded ? '✓ Added to basket' : `Add to basket · $${product.price.toLocaleString()}`}
                </button>
            </div>
        </div>
    );
};
