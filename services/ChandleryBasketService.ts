/**
 * ChandleryBasketService — local-only shopping basket for the curated
 * storefront.
 *
 * Persists a list of product IDs + quantities to Capacitor Preferences
 * under `thalassa_chandlery_basket`. No backend yet — basket lives on
 * the device. Multi-device sync would slot in by mirroring this state
 * to a Supabase table later; keeping it local for now means no schema
 * migration is needed to ship.
 *
 * Subscribers are notified on every change so the basket badge in the
 * page header and the basket drawer stay in sync without prop-drilling
 * through the view router.
 */

import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ChandleryBasket');
const STORAGE_KEY = 'thalassa_chandlery_basket';

export interface BasketLine {
    productId: string;
    quantity: number;
}

let _basket: BasketLine[] = [];
let _loaded = false;
const _listeners = new Set<(b: BasketLine[]) => void>();

function notify(): void {
    _listeners.forEach((fn) => {
        try {
            fn(_basket);
        } catch (e) {
            log.warn('listener threw:', e);
        }
    });
}

async function persist(): Promise<void> {
    try {
        await Preferences.set({
            key: STORAGE_KEY,
            value: JSON.stringify(_basket),
        });
    } catch (e) {
        log.warn('persist failed:', e);
    }
}

/**
 * Initialize the basket from Capacitor Preferences. Idempotent —
 * subsequent calls are no-ops. Returns the loaded basket so callers
 * that await this can render correctly on first paint.
 */
export async function loadBasket(): Promise<BasketLine[]> {
    if (_loaded) return _basket;
    try {
        const { value } = await Preferences.get({ key: STORAGE_KEY });
        if (value) {
            const parsed = JSON.parse(value) as BasketLine[];
            if (Array.isArray(parsed)) {
                _basket = parsed.filter(
                    (l) => typeof l?.productId === 'string' && typeof l?.quantity === 'number' && l.quantity > 0,
                );
            }
        }
    } catch (e) {
        log.warn('load failed — starting empty:', e);
    }
    _loaded = true;
    notify();
    return _basket;
}

export function getBasket(): BasketLine[] {
    return _basket;
}

/** Total item count (sum of quantities) — for the header badge. */
export function getBasketCount(): number {
    return _basket.reduce((sum, l) => sum + l.quantity, 0);
}

/**
 * Add a product to the basket. If it's already there, the quantity
 * increments. Triggers persistence + listener notification.
 */
export async function addToBasket(productId: string, quantity = 1): Promise<void> {
    if (!productId || quantity < 1) return;
    const existing = _basket.find((l) => l.productId === productId);
    if (existing) {
        existing.quantity += quantity;
    } else {
        _basket = [..._basket, { productId, quantity }];
    }
    // Make sure we always notify with a new array reference so React
    // state setters bound via useChandleryBasket() re-render.
    _basket = [..._basket];
    await persist();
    notify();
}

/** Set the exact quantity for a product. 0 removes it. */
export async function setQuantity(productId: string, quantity: number): Promise<void> {
    if (quantity <= 0) {
        return removeFromBasket(productId);
    }
    const existing = _basket.find((l) => l.productId === productId);
    if (existing) {
        existing.quantity = quantity;
        _basket = [..._basket];
        await persist();
        notify();
    } else {
        await addToBasket(productId, quantity);
    }
}

/** Remove a product entirely. */
export async function removeFromBasket(productId: string): Promise<void> {
    const before = _basket.length;
    _basket = _basket.filter((l) => l.productId !== productId);
    if (_basket.length !== before) {
        await persist();
        notify();
    }
}

/** Clear everything. */
export async function clearBasket(): Promise<void> {
    if (_basket.length === 0) return;
    _basket = [];
    await persist();
    notify();
}

/** Subscribe to basket changes. Returns the unsubscribe function. */
export function subscribeBasket(fn: (b: BasketLine[]) => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}
