/**
 * ChandleryPage — Thalassa's curated, vetted-storefront chandlery.
 *
 * Replaces the peer-to-peer Marketplace as the primary Chandlery surface.
 * Three SKUs for the Store One MVS — Copperhill PiCAN-M Hat, Xenarc 703WP
 * Display, Calypso Ultrasonic Portable Mini. UI-only this round; Stripe
 * + Supabase Edge Function checkout wires in the Q3-2026 sprint.
 *
 * Aesthetic brief: "1stDibs / Aesop / Apple Store" — quiet luxury, restrained
 * typography, generous breathing room, image-forward, zero SALE banners,
 * single accent colour. Deep dark mode native.
 *
 * Peer-to-peer marketplace stays reachable via a discreet footer link
 * ("Looking for used gear? Browse the Community Marketplace") so existing
 * Supabase listing-data isn't orphaned during the pivot.
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { STORE_ONE_PRODUCTS, type StoreOneProduct } from '../data/storeOne.products';
import { useSettings } from '../context/SettingsContext';
import { triggerHaptic } from '../utils/system';
import { lazyRetry } from '../utils/lazyRetry';

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

interface Compatibility {
    ok: boolean;
    label: string;
}

// ── Per-product gradient placeholders (Q3-2026 swap to real photography) ──
const PRODUCT_GRADIENT: Record<string, string> = {
    'copperhill-pican-m': 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)', // slate steel
    'xenarc-703wp': 'linear-gradient(135deg, #020617 0%, #1e3a8a 100%)', // deep night blue
    'calypso-ultrasonic-portable-mini': 'linear-gradient(135deg, #334155 0%, #075985 100%)', // atmospheric mist
};

const getProductGradient = (id: string): string =>
    PRODUCT_GRADIENT[id] || 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';

// ── Component ────────────────────────────────────────────────────────

export const ChandleryPage: React.FC<ChandleryPageProps> = ({ onBack: _onBack, onOpenDM }) => {
    const { settings } = useSettings();
    const [mode, setMode] = useState<'curated' | 'community'>('curated');
    const [selected, setSelected] = useState<StoreOneProduct | null>(null);
    // Graceful fallback: if a product image 404s or stalls, swap to the
    // per-product gradient placeholder for that one card only.
    const [brokenImageIds, setBrokenImageIds] = useState<Set<string>>(new Set());
    const markBroken = (id: string) =>
        setBrokenImageIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });

    const vessel = settings.vessel;
    const isObserver = vessel?.type === 'observer';
    const hasVessel = !!vessel && !isObserver;

    const checkCompatibility = (p: StoreOneProduct): Compatibility => {
        if (!p.requires_12v) {
            return { ok: true, label: 'Portable · works on any vessel' };
        }
        if (!hasVessel) {
            return { ok: false, label: 'Requires a vessel with 12V or NMEA 2000 power' };
        }
        return { ok: true, label: `Compatible with ${vessel?.name || 'your vessel'}` };
    };

    // ── Community marketplace mode (peer-to-peer, secondary) ──
    if (mode === 'community') {
        return <MarketplacePage onBack={() => setMode('curated')} onOpenDM={onOpenDM} />;
    }

    // ── Curated storefront (primary) ──
    return (
        <div className="flex-1 flex flex-col bg-slate-950 overflow-y-auto">
            {/* Hero */}
            <header className="px-6 pt-10 pb-8 max-w-2xl">
                <p className="text-[10px] font-medium uppercase tracking-[0.25em] text-white/30 mb-3">The Chandlery</p>
                <h1 className="text-[28px] font-semibold text-white leading-tight tracking-tight">
                    Curated hardware for the serious cruising sailor.
                </h1>
                <p className="text-sm text-white/50 mt-4 leading-relaxed">
                    Vetted gear that pairs with the Thalassa stack — chosen, tested, ready to install on the day it
                    arrives. No catalog density, no SKUs you'll never need.
                </p>
            </header>

            {/* Product list */}
            <main className="px-4 space-y-3 pb-4">
                {STORE_ONE_PRODUCTS.map((p) => {
                    const compat = checkCompatibility(p);
                    const showImage = !!p.imageUrl && !brokenImageIds.has(p.id);
                    return (
                        <ProductCard
                            key={p.id}
                            product={p}
                            compatibility={compat}
                            showImage={showImage}
                            onImageError={() => markBroken(p.id)}
                            onTap={() => {
                                triggerHaptic('light');
                                setSelected(p);
                            }}
                        />
                    );
                })}
            </main>

            {/* Lifecycle ownership tagline — sets the tone for what the chandlery becomes long-term */}
            <section className="px-6 pt-8 pb-6 max-w-2xl">
                <p className="text-[11px] uppercase tracking-[0.2em] text-white/30 mb-2">Lifecycle ownership</p>
                <p className="text-sm text-white/50 leading-relaxed">
                    Every purchase joins your Ship's Manifest. Service intervals, recall notices, manuals when you need
                    them — for as long as the gear is on board.
                </p>
            </section>

            {/* Community Marketplace fallback — discreet, not promoted */}
            <footer className="px-6 pt-6 pb-10 border-t border-white/[0.04]">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setMode('community');
                    }}
                    className="text-sm text-white/40 hover:text-white/70 transition-colors min-h-[44px]"
                >
                    Looking for used gear? Browse the Community Marketplace →
                </button>
            </footer>

            {/* Product detail overlay */}
            {selected && (
                <ProductDetail
                    product={selected}
                    compatibility={checkCompatibility(selected)}
                    showImage={!!selected.imageUrl && !brokenImageIds.has(selected.id)}
                    onImageError={() => markBroken(selected.id)}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
};

// ── Product card ─────────────────────────────────────────────────────

interface ProductCardProps {
    product: StoreOneProduct;
    compatibility: Compatibility;
    showImage: boolean;
    onImageError: () => void;
    onTap: () => void;
}

const ProductCard: React.FC<ProductCardProps> = ({ product, compatibility, showImage, onImageError, onTap }) => (
    <button
        onClick={onTap}
        aria-label={`${product.name} — $${product.price} USD`}
        className="w-full text-left bg-white/[0.02] border border-white/[0.06] rounded-2xl overflow-hidden active:scale-[0.99] transition-all hover:bg-white/[0.04] hover:border-white/[0.1]"
    >
        {/* Image-forward 4:3 hero — real photo when available, gradient fallback otherwise */}
        <div
            className="w-full aspect-[4/3] flex items-end p-6 relative bg-slate-900"
            style={!showImage ? { background: getProductGradient(product.id) } : undefined}
        >
            {showImage && product.imageUrl && (
                <img
                    src={product.imageUrl}
                    alt={product.name}
                    onError={onImageError}
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-contain bg-white/[0.02]"
                />
            )}
            {/* Bottom shadow only on gradient placeholder; photos read clearer without it */}
            {!showImage && <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />}
            <p className="relative text-[10px] font-medium uppercase tracking-[0.25em] text-white/50 z-10">
                {product.requires_12v ? 'Hardware · 12V' : 'Hardware · Wireless'}
            </p>
        </div>

        {/* Name + price + lede */}
        <div className="px-5 pt-5 pb-6">
            <h3 className="text-lg font-semibold text-white leading-snug">{product.name}</h3>
            <div className="flex items-baseline gap-2 mt-2">
                <span className="text-base text-white/75 tabular-nums">${product.price}</span>
                <span className="text-[11px] text-white/30">USD</span>
            </div>
            <p className="text-[13px] text-white/50 mt-3 leading-relaxed line-clamp-2">{product.description}</p>

            {/* Vessel-fit indicator — quiet but present */}
            <p className={`text-[11px] mt-4 ${compatibility.ok ? 'text-emerald-400/70' : 'text-amber-400/70'}`}>
                {compatibility.label}
            </p>
        </div>
    </button>
);

// ── Product detail (fullscreen overlay) ──────────────────────────────

interface ProductDetailProps {
    product: StoreOneProduct;
    compatibility: Compatibility;
    showImage: boolean;
    onImageError: () => void;
    onClose: () => void;
}

const ProductDetail: React.FC<ProductDetailProps> = ({ product, compatibility, showImage, onImageError, onClose }) =>
    // Portal to document.body — ChatPage's parent uses `chat-slide-forward`,
    // a CSS animation with `transform: translate3d(...)` that creates a
    // containing block, trapping `position: fixed` descendants inside the
    // chat content area instead of letting them escape to the viewport.
    // ChildCard solves the same problem with the same pattern.
    createPortal(
        <div className="fixed inset-0 z-[955] bg-slate-950 flex flex-col">
            {/* Header */}
            <div
                className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] flex-shrink-0"
                style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
            >
                <button
                    onClick={onClose}
                    aria-label="Close product detail"
                    className="w-11 h-11 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center transition-all active:scale-90"
                >
                    <span className="text-sky-400 text-lg">‹</span>
                </button>
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">The Chandlery</p>
                </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto">
                {/* Hero image — real photo when available, gradient fallback otherwise */}
                <div
                    className="w-full aspect-[4/3] relative bg-slate-900"
                    style={!showImage ? { background: getProductGradient(product.id) } : undefined}
                >
                    {showImage && product.imageUrl && (
                        <img
                            src={product.imageUrl}
                            alt={product.name}
                            onError={onImageError}
                            className="absolute inset-0 w-full h-full object-contain bg-white/[0.02]"
                        />
                    )}
                </div>

                {/* Body */}
                <div className="px-6 pt-10 pb-16 max-w-2xl">
                    <p className="text-[10px] font-medium uppercase tracking-[0.25em] text-white/40 mb-3">
                        {product.requires_12v ? 'Hardware · 12V' : 'Hardware · Wireless'}
                    </p>
                    <h1 className="text-2xl font-semibold text-white leading-tight tracking-tight">{product.name}</h1>
                    <div className="flex items-baseline gap-2 mt-3">
                        <span className="text-xl text-white/80 tabular-nums">${product.price}</span>
                        <span className="text-xs text-white/30">USD</span>
                    </div>

                    <p className="text-sm text-white/70 mt-8 leading-relaxed">{product.description}</p>

                    {/* Vessel-fit panel */}
                    <div
                        className={`mt-8 p-4 rounded-xl border ${
                            compatibility.ok
                                ? 'bg-emerald-500/[0.04] border-emerald-500/15'
                                : 'bg-amber-500/[0.04] border-amber-500/15'
                        }`}
                    >
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-1.5">Vessel Fit</p>
                        <p className={`text-sm ${compatibility.ok ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>
                            {compatibility.label}
                        </p>
                    </div>

                    {/* Specs */}
                    <section className="mt-10">
                        <p className="text-[10px] font-medium uppercase tracking-[0.25em] text-white/40 mb-4">
                            Specifications
                        </p>
                        <ul className="space-y-2.5">
                            {product.specs.map((s, i) => (
                                <li key={i} className="text-sm text-white/70 leading-relaxed pl-5 relative">
                                    <span className="absolute left-0 top-[0.55rem] w-1 h-1 rounded-full bg-white/40" />
                                    {s}
                                </li>
                            ))}
                        </ul>
                    </section>

                    {/* Lifecycle hint */}
                    <section className="mt-10 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-2">Lifecycle ownership</p>
                        <p className="text-sm text-white/60 leading-relaxed">
                            On purchase, this product joins your Ship's Manifest. Service intervals, recall notices, and
                            manufacturer manuals stay with the gear for as long as it's on board.
                        </p>
                    </section>

                    {/* CTA — placeholder until Stripe wires in Q3 */}
                    <section className="mt-10">
                        <button
                            disabled
                            className="w-full py-4 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white/60 font-medium cursor-not-allowed min-h-[52px]"
                        >
                            Available Q3 2026
                        </button>
                        <p className="text-[11px] text-white/30 text-center mt-3 leading-relaxed">
                            Checkout opens with the Q3 sprint. Sign in for early access notifications.
                        </p>
                    </section>
                </div>
            </div>
        </div>,
        document.body,
    );

export default ChandleryPage;
