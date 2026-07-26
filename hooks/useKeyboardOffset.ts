import { useEffect, useState } from 'react';
import { subscribeKeyboardHeight } from '../utils/keyboardScroll';

/**
 * React view of Thalassa's shared keyboard measurement.
 *
 * Use this only when a fixed composer, drawer, or modal must physically move
 * out of the keyboard's way. Normal fields are already handled by the global
 * focus guard, so they do not need a per-component listener.
 */
export function useKeyboardOffset(enabled = true): number {
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        if (!enabled) {
            setKeyboardHeight(0);
            return;
        }

        return subscribeKeyboardHeight(setKeyboardHeight);
    }, [enabled]);

    return keyboardHeight;
}
