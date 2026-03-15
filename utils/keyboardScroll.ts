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
        import('@capacitor/keyboard')
            .then(({ Keyboard }) => {
                Keyboard.addListener('keyboardWillHide', () => {
                    if (lastScrollParent) {
                        lastScrollParent.scrollTo({
                            top: 0,
                            behavior: 'smooth',
                        });
                    }
                });
            })
            .catch(() => {
                /* Keyboard plugin not available */
            });
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
 * Uses scrollIntoView which handles all container types including
 * fixed-position modals. The 'center' block alignment places the
 * input nicely above the keyboard (top half of screen).
 */
export function scrollInputAboveKeyboard(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
): void {
    const el = e.target as HTMLElement;

    // Ensure the keyboard-hide bounce-back listener is registered
    ensureHideListener();

    // Remember the scroll parent for bounce-back
    const scrollParent = findScrollParent(el);
    if (scrollParent) {
        lastScrollParent = scrollParent;
    }

    // Wait for keyboard animation to complete, then scroll into view.
    // Use a small initial delay (50ms) to let iOS register the focus.
    setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, KEYBOARD_ANIM_MS);
}
