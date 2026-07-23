/**
 * BasketDrawer — modal sheet showing what the punter has lined up to
 * buy. Quantity +/- per line, swipe-or-tap to remove, line subtotal,
 * grand total, and an explicit catalogue-preview checkout state.
 */
import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { STORE_ONE_PRODUCTS, type StoreOneProduct } from '../../data/storeOne.products';
import { removeFromBasket, setQuantity, type BasketLine } from '../../services/ChandleryBasketService';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface BasketDrawerProps {
    open: boolean;
    onClose: () => void;
    lines: BasketLine[];
}

interface ResolvedLine {
    line: BasketLine;
    product: StoreOneProduct | undefined;
}

export const BasketDrawer: React.FC<BasketDrawerProps> = ({ open, onClose, lines }) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    if (!open) return null;

    const resolved: ResolvedLine[] = lines.map((line) => ({
        line,
        product: STORE_ONE_PRODUCTS.find((p) => p.id === line.productId),
    }));

    const subtotal = resolved.reduce((sum, r) => sum + (r.product?.price ?? 0) * r.line.quantity, 0);
    const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
    const hasPurchasableLines = resolved.some((line) => line.product);

    const drawer = (
        <div className="fixed inset-0 z-[1100] flex items-end justify-center">
            <div role="presentation" onClick={onClose} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="basket-title"
                className="relative w-full max-w-2xl max-h-[88vh] flex flex-col bg-slate-950 border-t border-x border-white/10 rounded-t-3xl shadow-2xl animate-in slide-in-from-bottom duration-200"
            >
                {/* Drag handle visual */}
                <div className="flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 rounded-full bg-white/15" />
                </div>

                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-2 pb-3 border-b border-white/5">
                    <h2 id="basket-title" className="text-base font-bold text-white">
                        Your Basket
                        <span className="ml-2 text-xs font-mono text-slate-400">({itemCount})</span>
                    </h2>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Close basket"
                        className="p-2 -mr-2 text-slate-400 hover:text-white"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Lines */}
                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
                    {lines.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="text-4xl mb-3">🧺</div>
                            <p className="text-sm font-bold text-white mb-1">Your basket is empty</p>
                            <p className="text-xs text-slate-400">Tap an item to add it from the Chandlery.</p>
                        </div>
                    ) : (
                        <div className="space-y-2.5">
                            {resolved.map(({ line, product }) => {
                                if (!product) {
                                    // Orphaned line — product removed from catalog. Show a
                                    // "remove this" prompt rather than hiding silently.
                                    return (
                                        <div
                                            key={line.productId}
                                            className="px-3 py-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] flex items-center justify-between"
                                        >
                                            <div className="text-xs text-amber-200/90">Product no longer available</div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    void removeFromBasket(line.productId);
                                                }}
                                                className="text-xs font-bold text-amber-300"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    );
                                }
                                const lineTotal = product.price * line.quantity;
                                return (
                                    <div
                                        key={line.productId}
                                        className="px-3 py-3 rounded-xl border border-white/[0.08] bg-white/[0.02] flex items-center gap-3"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-white truncate">{product.name}</div>
                                            <div className="text-[11px] text-sky-300/80 mt-0.5">
                                                ${product.price.toLocaleString()} ea
                                            </div>
                                        </div>
                                        {/* Qty stepper */}
                                        <div className="flex items-center gap-1 shrink-0">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    void setQuantity(line.productId, line.quantity - 1);
                                                }}
                                                aria-label={`Decrease quantity of ${product.name}`}
                                                className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 transition-all text-white font-bold flex items-center justify-center"
                                            >
                                                −
                                            </button>
                                            <span className="w-6 text-center text-sm font-mono text-white">
                                                {line.quantity}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    void setQuantity(line.productId, line.quantity + 1);
                                                }}
                                                aria-label={`Increase quantity of ${product.name}`}
                                                className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 transition-all text-white font-bold flex items-center justify-center"
                                            >
                                                +
                                            </button>
                                        </div>
                                        <div className="text-sm font-bold text-white w-16 text-right shrink-0">
                                            ${lineTotal.toLocaleString()}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer — subtotal + truthful preview state */}
                {hasPurchasableLines && (
                    <div className="border-t border-white/5 px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs uppercase tracking-wider text-slate-400 font-bold">Subtotal</span>
                            <span className="text-xl font-black text-white">${subtotal.toLocaleString()}</span>
                        </div>
                        <p id="chandlery-checkout-note" className="mb-3 text-xs leading-relaxed text-slate-400">
                            Catalogue preview — online checkout is disabled for this beta. Your basket stays saved on
                            this device.
                        </p>
                        <button
                            type="button"
                            disabled
                            aria-describedby="chandlery-checkout-note"
                            aria-label="Checkout unavailable during beta"
                            className="w-full h-12 rounded-xl border border-white/10 bg-white/[0.05] text-slate-400 font-bold cursor-not-allowed"
                        >
                            Checkout disabled in beta
                        </button>
                    </div>
                )}
            </div>
        </div>
    );

    return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
};
