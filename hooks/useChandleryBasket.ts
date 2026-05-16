/**
 * useChandleryBasket — React hook that mirrors the singleton basket
 * state from services/ChandleryBasketService into component state.
 *
 * On mount: loads the persisted basket from Capacitor Preferences,
 * subscribes for future changes, and unsubscribes on unmount.
 *
 * Returns { lines, count } as reactive values. Use the service's
 * `addToBasket`, `removeFromBasket` etc. directly to mutate.
 */
import { useEffect, useState } from 'react';
import { getBasket, loadBasket, subscribeBasket, type BasketLine } from '../services/ChandleryBasketService';

export function useChandleryBasket(): { lines: BasketLine[]; count: number } {
    const [lines, setLines] = useState<BasketLine[]>(() => getBasket());

    useEffect(() => {
        let cancelled = false;
        void loadBasket().then((b) => {
            if (!cancelled) setLines(b);
        });
        const unsub = subscribeBasket((b) => {
            if (!cancelled) setLines(b);
        });
        return () => {
            cancelled = true;
            unsub();
        };
    }, []);

    const count = lines.reduce((s, l) => s + l.quantity, 0);
    return { lines, count };
}
