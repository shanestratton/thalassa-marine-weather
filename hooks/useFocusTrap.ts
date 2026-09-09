/**
 * Shared keyboard focus management for modal dialogs and sheets.
 *
 * When active, focus moves into the container, Tab and Shift+Tab stay
 * inside it, Escape can invoke the supplied dismiss action, and focus is
 * restored to the control that opened the dialog when it closes.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { isAvailableForFocus, isTextEntry } from '../utils/focusableFields';
import { usePaneModalLock, usePaneScope } from '../context/PanePortalContext';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

// More than one modal can be mounted at once (for example, a recipe form
// opened from a recipe picker). Every trap keeps its own restore target, but
// only the most recently activated trap may handle keyboard input. Without
// this stack, an underlying dialog can pull Tab focus out of the child dialog.
const activeTrapStack: HTMLElement[] = [];

const paneOf = (element: Element | null): Element | null =>
    element?.closest('[data-pane-portal], [data-split-pane]') ?? null;

function activeTrapForFocus(): HTMLElement | undefined {
    // An application alarm still owns the whole keyboard. Pane dialogs only
    // trap keys within their pane, so opening a left sheet cannot hijack Tab
    // after the skipper taps a field in the right pane.
    const globalTrap = [...activeTrapStack].reverse().find((trap) => !paneOf(trap));
    if (globalTrap) return globalTrap;
    const focusedPane = paneOf(document.activeElement);
    const paneId = focusedPane?.getAttribute('data-pane-portal') ?? focusedPane?.getAttribute('data-split-pane');
    return [...activeTrapStack].reverse().find((trap) => {
        const pane = paneOf(trap);
        return paneId && (pane?.getAttribute('data-pane-portal') ?? pane?.getAttribute('data-split-pane')) === paneId;
    });
}

export interface FocusTrapOptions {
    /** Preferred control. Otherwise start at the first editable field, then the first control. */
    initialFocusRef?: RefObject<HTMLElement | null>;
    /** Optional Escape-key action. */
    onEscape?: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => (element.tabIndex >= 0 || isTextEntry(element)) && isAvailableForFocus(element),
    );
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
    isActive: boolean,
    options: FocusTrapOptions = {},
): RefObject<T> {
    const containerRef = useRef<T>(null);
    const pane = usePaneScope();
    usePaneModalLock(isActive, containerRef);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useLayoutEffect(() => {
        if (!isActive || typeof document === 'undefined') return;
        // A child portal acquires its inert lock before parent passive effects.
        // WebKit immediately blurs the opener when its pane becomes inert, so
        // capture the restore target before those locks run. Initial autofocus
        // stays below, after the pane's portal host has attached to the body.
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }, [isActive, pane?.host]);

    useEffect(() => {
        if (!isActive || typeof document === 'undefined') return;

        const container = containerRef.current;
        if (!container) return;
        // Capture this activation's restore target in the cleanup closure:
        // a later layout pass can prepare the next pane before this passive
        // effect has cleaned up the previous one.
        const previousFocus = previousFocusRef.current;

        const descendants = focusableElements(container);
        const preferred = optionsRef.current.initialFocusRef?.current;
        // React autoFocus or a tap on the second field may already have chosen
        // the target before this effect runs. Never pull that focus back to field 1.
        const active = document.activeElement;
        const existingTarget =
            active instanceof HTMLElement &&
            active !== container &&
            container.contains(active) &&
            isAvailableForFocus(active)
                ? active
                : null;
        const initialTarget =
            existingTarget ??
            (preferred && container.contains(preferred) && isAvailableForFocus(preferred)
                ? preferred
                : (descendants.find(isTextEntry) ?? descendants[0]));
        const previousScope = container.getAttribute('data-keyboard-focus-scope');
        const previousModal = container.getAttribute('aria-modal');
        const owningPane = paneOf(container);
        if (owningPane) container.removeAttribute('aria-modal');
        container.setAttribute('data-keyboard-focus-scope', '');
        const addedTabIndex = !initialTarget && !container.hasAttribute('tabindex');
        if (addedTabIndex) container.setAttribute('tabindex', '-1');
        (initialTarget ?? container).focus({ preventScroll: true });
        activeTrapStack.push(container);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (activeTrapForFocus() !== container) return;

            if (event.key === 'Escape' && container.contains(document.activeElement)) {
                const onEscape = optionsRef.current.onEscape;
                if (onEscape) {
                    event.preventDefault();
                    event.stopPropagation();
                    onEscape();
                }
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = focusableElements(container);
            if (focusable.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const activeElement = document.activeElement;

            if (!container.contains(activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        return () => {
            const focusedElsewhere =
                owningPane &&
                document.activeElement instanceof HTMLElement &&
                document.activeElement !== document.body &&
                !container.contains(document.activeElement);
            document.removeEventListener('keydown', handleKeyDown);
            const stackIndex = activeTrapStack.lastIndexOf(container);
            if (stackIndex !== -1) activeTrapStack.splice(stackIndex, 1);
            if (addedTabIndex) container.removeAttribute('tabindex');
            if (previousScope === null) container.removeAttribute('data-keyboard-focus-scope');
            else container.setAttribute('data-keyboard-focus-scope', previousScope);
            if (previousModal !== null) container.setAttribute('aria-modal', previousModal);
            if (!focusedElsewhere && previousFocus?.isConnected) {
                const restoreTarget = previousFocus;
                if (restoreTarget.closest('[inert]')) {
                    // During conditional unmount React cleans the parent trap
                    // before the child portal releases its final pane lock.
                    // Focusing an inert opener is ignored by the browser. Wait
                    // until all synchronous cleanups finish, without stealing
                    // focus if another pane/dialog acquired it in the meantime.
                    const focusAtClose = document.activeElement;
                    queueMicrotask(() => {
                        const active = document.activeElement;
                        if (
                            restoreTarget.isConnected &&
                            isAvailableForFocus(restoreTarget) &&
                            (active === focusAtClose || active === document.body || container.contains(active))
                        )
                            restoreTarget.focus({ preventScroll: true });
                    });
                } else {
                    restoreTarget.focus({ preventScroll: true });
                }
            }
        };
    }, [isActive, pane?.host]);

    return containerRef;
}
