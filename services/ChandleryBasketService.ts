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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('ChandleryBasket');
const STORAGE_KEY = 'thalassa_chandlery_basket';

export interface BasketLine {
    productId: string;
    quantity: number;
}

let _basket: BasketLine[] = [];
let _loadedScope: AuthIdentityScope | null = null;
let _loadInFlight: { scope: AuthIdentityScope; promise: Promise<BasketLine[]> } | null = null;
const _listeners = new Set<(b: BasketLine[]) => void>();

function notify(): void {
    const snapshot = _basket.map((line) => ({ ...line }));
    _listeners.forEach((fn) => {
        try {
            fn(snapshot);
        } catch (e) {
            log.warn('listener threw:', e);
        }
    });
}

function storageKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(STORAGE_KEY, scope);
}

function sanitizeBasket(value: unknown): BasketLine[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(
            (line): line is BasketLine =>
                !!line &&
                typeof line === 'object' &&
                typeof (line as BasketLine).productId === 'string' &&
                Number.isFinite((line as BasketLine).quantity) &&
                (line as BasketLine).quantity > 0,
        )
        .map((line) => ({ productId: line.productId, quantity: Math.floor(line.quantity) }));
}

async function persist(snapshot: BasketLine[], scope: AuthIdentityScope): Promise<void> {
    try {
        await Preferences.set({
            key: storageKey(scope),
            value: JSON.stringify(snapshot),
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
    const scope = getAuthIdentityScope();
    if (_loadedScope?.generation === scope.generation) return getBasket();
    if (_loadInFlight?.scope.generation === scope.generation) return _loadInFlight.promise;

    const promise = (async (): Promise<BasketLine[]> => {
        let loaded: BasketLine[] = [];
        try {
            // The historical unscoped key has no owner marker and is never
            // guessed into whichever account happens to sign in first.
            const { value } = await Preferences.get({ key: storageKey(scope) });
            if (value) {
                loaded = sanitizeBasket(JSON.parse(value));
            }
        } catch (e) {
            log.warn('load failed — starting empty:', e);
        }

        if (!isAuthIdentityScopeCurrent(scope)) return [];
        _basket = loaded;
        _loadedScope = scope;
        notify();
        return getBasket();
    })();

    _loadInFlight = { scope, promise };
    try {
        return await promise;
    } finally {
        if (_loadInFlight?.promise === promise) _loadInFlight = null;
    }
}

export function getBasket(): BasketLine[] {
    return _basket.map((line) => ({ ...line }));
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
    const scope = getAuthIdentityScope();
    await loadBasket();
    if (!isAuthIdentityScopeCurrent(scope)) return;

    const existing = _basket.find((l) => l.productId === productId);
    if (existing) {
        existing.quantity += quantity;
    } else {
        _basket = [..._basket, { productId, quantity }];
    }
    // Make sure we always notify with a new array reference so React
    // state setters bound via useChandleryBasket() re-render.
    _basket = [..._basket];
    const snapshot = getBasket();
    await persist(snapshot, scope);
    if (isAuthIdentityScopeCurrent(scope)) notify();
}

/** Set the exact quantity for a product. 0 removes it. */
export async function setQuantity(productId: string, quantity: number): Promise<void> {
    if (!productId) return;
    const scope = getAuthIdentityScope();
    await loadBasket();
    if (!isAuthIdentityScopeCurrent(scope)) return;

    if (quantity <= 0) _basket = _basket.filter((line) => line.productId !== productId);
    const existing = _basket.find((l) => l.productId === productId);
    if (quantity > 0 && existing) {
        existing.quantity = quantity;
        _basket = [..._basket];
    } else if (quantity > 0) {
        _basket = [..._basket, { productId, quantity }];
    }
    const snapshot = getBasket();
    await persist(snapshot, scope);
    if (isAuthIdentityScopeCurrent(scope)) notify();
}

/** Remove a product entirely. */
export async function removeFromBasket(productId: string): Promise<void> {
    const scope = getAuthIdentityScope();
    await loadBasket();
    if (!isAuthIdentityScopeCurrent(scope)) return;

    const before = _basket.length;
    _basket = _basket.filter((l) => l.productId !== productId);
    if (_basket.length !== before) {
        const snapshot = getBasket();
        await persist(snapshot, scope);
        if (isAuthIdentityScopeCurrent(scope)) notify();
    }
}

/** Clear everything. */
export async function clearBasket(): Promise<void> {
    const scope = getAuthIdentityScope();
    await loadBasket();
    if (!isAuthIdentityScopeCurrent(scope)) return;
    _basket = [];
    await persist([], scope);
    if (isAuthIdentityScopeCurrent(scope)) notify();
}

/** Subscribe to basket changes. Returns the unsubscribe function. */
export function subscribeBasket(fn: (b: BasketLine[]) => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}

// A mounted chandlery page survives auth transitions. Hide A synchronously,
// then hydrate B's separate Preferences namespace without requiring a remount.
subscribeAuthIdentityScope((next) => {
    _basket = [];
    _loadedScope = null;
    _loadInFlight = null;
    notify();
    void loadBasket().then(() => {
        // loadBasket captures the same synchronous scope. The explicit check
        // documents that a later transition owns any subsequent notification.
        if (!isAuthIdentityScopeCurrent(next)) return;
    });
});
