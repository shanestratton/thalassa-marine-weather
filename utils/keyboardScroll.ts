/**
 * keyboardScroll — Scroll focused input above the iOS keyboard + accessory bar.
 *
 * On iOS with Capacitor (KeyboardResize.None), the keyboard overlays the
 * webview entirely. Neither the viewport nor scroll containers know the
 * keyboard is there.
 *
 * This utility:
 *  1. Waits for the keyboard animation to finish (400ms)
 *  2. Uses `visualViewport` to detect the actual visible area
 *  3. Scrolls the nearest scrollable ancestor so the input sits
 *     in the TOP QUARTER of the visible area — well clear of the
 *     keyboard + its ~44px accessory bar (tick / up-down arrows)
 *  4. Listens for keyboard dismiss (visualViewport resize back up)
 *     and scrolls the container back to its natural position
 *
 * Usage:
 *   <input onFocus={scrollInputAboveKeyboard} />
 *   // FormField does this automatically
 */

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

// Track active cleanup handlers for keyboard dismiss
let activeCleanup: (() => void) | null = null;

/**
 * onFocus handler — scrolls the focused input above the keyboard.
 *
 * Usage:
 *   <input onFocus={scrollInputAboveKeyboard} />
 *   <FormField onFocus={scrollInputAboveKeyboard} />
 */
export function scrollInputAboveKeyboard(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
): void {
    const el = e.target as HTMLElement;

    // Clean up previous listener if one was active
    if (activeCleanup) {
        activeCleanup();
        activeCleanup = null;
    }

    setTimeout(() => {
        const scrollParent = findScrollParent(el);
        if (!scrollParent) {
            // Fallback: just use scrollIntoView
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        // Get visible viewport height (accounts for keyboard on iOS)
        const visibleHeight = window.visualViewport
            ? window.visualViewport.height
            : window.innerHeight;
        const fullHeight = window.innerHeight;

        // If no keyboard detected (visible ≈ full), skip scrolling
        if (visibleHeight > fullHeight - 50) return;

        // Where the element sits relative to the scroll container
        const elRect = el.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();

        // Target: place the input at 20% from the top of the VISIBLE area
        // This puts it in the upper portion, well clear of keyboard + accessory bar
        const targetY = visibleHeight * 0.20;
        const currentY = elRect.top - parentRect.top + scrollParent.scrollTop;
        const scrollTo = currentY - targetY;

        scrollParent.scrollTo({
            top: Math.max(0, scrollTo),
            behavior: 'smooth',
        });

        // ── Keyboard dismiss: bounce back ──
        // Listen for visualViewport resize (keyboard going away)
        const savedScrollTop = 0; // We want to go back to top
        const vp = window.visualViewport;
        if (vp) {
            const onResize = () => {
                // If viewport height is back near full height, keyboard dismissed
                if (vp.height > fullHeight - 50) {
                    scrollParent.scrollTo({
                        top: savedScrollTop,
                        behavior: 'smooth',
                    });
                    cleanup();
                }
            };

            const cleanup = () => {
                vp.removeEventListener('resize', onResize);
                if (activeCleanup === cleanup) activeCleanup = null;
            };

            vp.addEventListener('resize', onResize);
            activeCleanup = cleanup;

            // Safety: clean up after 30s max (prevent leak if dismiss never fires)
            setTimeout(cleanup, 30000);
        }
    }, KEYBOARD_ANIM_MS);
}
