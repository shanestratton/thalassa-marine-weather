/**
 * keyboardScroll — Scroll focused input above the iOS keyboard + accessory bar.
 *
 * On iOS with Capacitor (KeyboardResize.None), the keyboard overlays the
 * webview. The viewport doesn't resize — we MUST scroll manually.
 *
 * Strategy:
 *  1. On focus, wait for keyboard animation (400ms)
 *  2. Scroll the input's nearest scrollable ancestor so the field sits
 *     in the upper 1/4 of the screen (clear of keyboard + accessory bar)
 *  3. On keyboard hide (Capacitor event), scroll back to top
 *
 * Usage:
 *   <input onFocus={scrollInputAboveKeyboard} />
 *   // FormField does this automatically
 */

import { Capacitor } from '@capacitor/core';

const KEYBOARD_ANIM_MS = 400;

/**
 * Finds the nearest scrollable ancestor of an element.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
    let parent = el.parentElement;
    while (parent) {
        const { overflowY } = getComputedStyle(parent);
        if (overflowY === 'auto' || overflowY === 'scroll') return parent;
        parent = parent.parentElement;
    }
    return null;
}

// Track whether we've registered the keyboard hide listener
let hideListenerRegistered = false;
let lastScrollParent: HTMLElement | null = null;

/**
 * Register a one-time listener for keyboard hide (Capacitor).
 * Scrolls the last active scroll parent back to 0.
 */
function ensureHideListener() {
    if (hideListenerRegistered) return;
    hideListenerRegistered = true;

    if (Capacitor.isNativePlatform()) {
        import('@capacitor/keyboard').then(({ Keyboard }) => {
            Keyboard.addListener('keyboardWillHide', () => {
                if (lastScrollParent) {
                    lastScrollParent.scrollTo({
                        top: 0,
                        behavior: 'smooth',
                    });
                }
            });
        }).catch(() => { /* Keyboard plugin not available */ });
    } else {
        // Web fallback: listen for visualViewport resize
        const vp = window.visualViewport;
        if (vp) {
            let wasKeyboardOpen = false;
            vp.addEventListener('resize', () => {
                const isNowFull = vp.height > window.innerHeight - 100;
                if (wasKeyboardOpen && isNowFull && lastScrollParent) {
                    lastScrollParent.scrollTo({
                        top: 0,
                        behavior: 'smooth',
                    });
                }
                wasKeyboardOpen = !isNowFull;
            });
        }
    }
}

/**
 * onFocus handler — scrolls the focused input above the keyboard.
 *
 * Always scrolls (doesn't try to detect if keyboard is present).
 * The keyboard is ALWAYS present when an input gets focus on mobile.
 */
export function scrollInputAboveKeyboard(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
): void {
    const el = e.target as HTMLElement;

    // Ensure the keyboard-hide bounce-back listener is registered
    ensureHideListener();

    setTimeout(() => {
        const scrollParent = findScrollParent(el);
        if (!scrollParent) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        // Remember for bounce-back
        lastScrollParent = scrollParent;

        // Get element position relative to the scroll container
        const elRect = el.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();

        // Target: place the input ~100px from the top of the screen.
        // The keyboard + accessory bar takes ~50% of screen height,
        // so the top quarter is the safe zone.
        const targetFromTop = 100;
        const currentScrollOffset = scrollParent.scrollTop;
        const elTopInContainer = elRect.top - parentRect.top + currentScrollOffset;
        const scrollTo = elTopInContainer - targetFromTop;

        scrollParent.scrollTo({
            top: Math.max(0, scrollTo),
            behavior: 'smooth',
        });
    }, KEYBOARD_ANIM_MS);
}
