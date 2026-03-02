/**
 * keyboardScroll — Scroll focused input above the iOS keyboard + accessory bar.
 *
 * On iOS the keyboard doesn't resize the viewport, it overlays it.
 * `scrollIntoView({ block: 'center' })` centres within the FULL viewport,
 * not the visible area above the keyboard.
 *
 * This utility:
 *  1. Waits for the keyboard animation to finish (350ms)
 *  2. Uses `visualViewport` to get the actual visible height
 *  3. Scrolls the nearest scrollable ancestor so the input sits
 *     comfortably in the middle of the VISIBLE area (above the keyboard
 *     + its ~44px accessory bar with tick/arrows)
 *
 * Usage:  <input onFocus={scrollInputAboveKeyboard} />
 */

const KEYBOARD_ANIM_MS = 350;

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

        // Where the element sits relative to the scroll container
        const elRect = el.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();

        // Target: place the input at roughly 40% from the top of the
        // visible area — comfortably above the keyboard accessory bar
        const targetY = visibleHeight * 0.35;
        const currentY = elRect.top - parentRect.top + scrollParent.scrollTop;
        const scrollTo = currentY - targetY;

        scrollParent.scrollTo({
            top: Math.max(0, scrollTo),
            behavior: 'smooth',
        });
    }, KEYBOARD_ANIM_MS);
}
