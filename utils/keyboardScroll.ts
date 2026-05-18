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
 * Compute-and-scroll approach (replaces the old `scrollIntoView({block:
 * 'center'})` which had a fatal flaw: on iOS with `KeyboardResize.None`
 * the layout viewport is the full screen, so "center" placed the input
 * roughly where the keyboard's top edge lives — covered, not above).
 *
 * What this does instead: compute where the input currently sits inside
 * its nearest scrollable ancestor, then scroll that container so the
 * input's top edge ends up TARGET_TOP_OFFSET_PX (80 px) below the
 * scrollable area's top. That puts the field firmly in the upper third
 * of the screen on every phone form factor, with breathing room for a
 * sticky page header — and well clear of the keyboard regardless of
 * its actual height.
 *
 * Falls back to `scrollIntoView({block:'start'})` if the input has no
 * scrollable ancestor (e.g. it lives in a non-scrolling fixed-position
 * modal whose viewport IS the visual viewport).
 *
 * Bug fix 2026-05-18 (Shane: "the keyboard covers the destination box
 * on the Plan page, I can't read it"). The Plan page's input column
 * lives inside a flex-1 overflow-y-auto container, so the find-scroll-
 * parent path is taken and the compute-and-scroll lifts the field.
 */
const TARGET_TOP_OFFSET_PX = 80;

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

    // Wait for keyboard animation to complete, then position the input.
    setTimeout(() => {
        if (document.activeElement !== el) return;
        if (scrollParent) {
            const inputRect = el.getBoundingClientRect();
            const parentRect = scrollParent.getBoundingClientRect();
            const targetTop = parentRect.top + TARGET_TOP_OFFSET_PX;
            const scrollDelta = inputRect.top - targetTop;
            if (Math.abs(scrollDelta) > 1) {
                scrollParent.scrollBy({ top: scrollDelta, behavior: 'smooth' });
            }
        } else {
            // No scroll ancestor — fall back to scrollIntoView at the
            // start (top) of the visible area, then nudge down to leave
            // header breathing room.
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            window.scrollBy({ top: -TARGET_TOP_OFFSET_PX, behavior: 'smooth' });
        }
    }, KEYBOARD_ANIM_MS);
}

/**
 * Global focusin listener — automatically scrolls ANY input/textarea/select
 * above the keyboard without requiring per-component onFocus wiring.
 *
 * Call once from App init. Idempotent — safe to call multiple times.
 */
let globalListenerAttached = false;

export function initGlobalKeyboardScroll(): void {
    if (globalListenerAttached) return;
    globalListenerAttached = true;

    ensureHideListener();

    document.addEventListener(
        'focusin',
        (e: FocusEvent) => {
            const el = e.target;
            if (
                !(el instanceof HTMLInputElement) &&
                !(el instanceof HTMLTextAreaElement) &&
                !(el instanceof HTMLSelectElement)
            ) {
                return;
            }

            // Skip inputs that opt out (e.g. search bars that handle their own scroll)
            if (el.dataset.noKeyboardScroll) return;

            const scrollParent = findScrollParent(el);
            if (scrollParent) {
                lastScrollParent = scrollParent;
            }

            setTimeout(() => {
                // Re-check that the element is still focused (user may have blurred quickly)
                if (document.activeElement !== el) return;
                if (scrollParent) {
                    const inputRect = el.getBoundingClientRect();
                    const parentRect = scrollParent.getBoundingClientRect();
                    const targetTop = parentRect.top + TARGET_TOP_OFFSET_PX;
                    const scrollDelta = inputRect.top - targetTop;
                    if (Math.abs(scrollDelta) > 1) {
                        scrollParent.scrollBy({ top: scrollDelta, behavior: 'smooth' });
                    }
                } else {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    window.scrollBy({ top: -TARGET_TOP_OFFSET_PX, behavior: 'smooth' });
                }
            }, KEYBOARD_ANIM_MS);
        },
        { passive: true },
    );
}
