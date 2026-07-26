/**
 * Keyboard avoidance for the whole application.
 *
 * Thalassa deliberately uses Capacitor's `KeyboardResize.None`: it keeps maps
 * and the app shell stable, but it also means the iOS keyboard sits on top of
 * the WebView instead of making the browser layout viewport smaller.  Native
 * browser keyboard handling therefore cannot be trusted to keep a focused
 * field visible.
 *
 * This module is the single source of truth for that behaviour.  It combines
 * the native Keyboard height (the only reliable signal in a Capacitor iOS
 * WebView) with `visualViewport` on the web, and moves the *nearest scrolling
 * surface* just enough to keep the actual focused editable above the keyboard.
 * It intentionally does not reset a form's scroll position when the keyboard
 * closes: losing a user's place in a long form is as frustrating as having the
 * field covered in the first place.
 */

import { Capacitor } from '@capacitor/core';

const KEYBOARD_THRESHOLD_PX = 80;
const TOP_BREATHING_ROOM_PX = 72;
const BOTTOM_BREATHING_ROOM_PX = 20;
const FOCUS_SETTLE_DELAYS_MS = [0, 120, 360] as const;

type KeyboardListenerHandle = { remove: () => Promise<void> | void };

interface KeyboardViewport {
    top: number;
    bottom: number;
    height: number;
    keyboardHeight: number;
}

let nativeKeyboardHeight = 0;
let globalCleanup: (() => void) | null = null;
let globalConsumerCount = 0;
let scheduledFocusTimers: ReturnType<typeof setTimeout>[] = [];
let publishedKeyboardHeight = 0;
const keyboardHeightSubscribers = new Set<(height: number) => void>();

function setKeyboardCssState(height: number): void {
    if (typeof document === 'undefined') return;
    const safeHeight = Math.max(0, Math.round(height));
    document.documentElement.style.setProperty('--thalassa-keyboard-height', `${safeHeight}px`);
    document.documentElement.dataset.keyboardOpen = safeHeight > 0 ? 'true' : 'false';
}

function publishKeyboardHeight(height: number): void {
    const safeHeight = Math.max(0, Math.round(height));
    if (safeHeight === publishedKeyboardHeight) return;
    publishedKeyboardHeight = safeHeight;
    setKeyboardCssState(safeHeight);
    keyboardHeightSubscribers.forEach((subscriber) => subscriber(safeHeight));
}

function visualViewportKeyboardHeight(): number {
    if (typeof window === 'undefined' || !window.visualViewport) return 0;
    const viewport = window.visualViewport;
    // `offsetTop` matters on Safari when browser chrome is moving.  A small
    // difference is normal chrome movement, not a keyboard, so do not jitter
    // a layout for it.
    const occluded = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    return occluded >= KEYBOARD_THRESHOLD_PX ? occluded : 0;
}

function effectiveKeyboardHeight(): number {
    return Math.max(nativeKeyboardHeight, visualViewportKeyboardHeight());
}

/**
 * The portion of the screen where a text field can safely be read and edited.
 * Exported for focused unit tests and for specialised surfaces that need the
 * same geometry (rather than inventing another keyboard calculation).
 */
export function getKeyboardViewport(): KeyboardViewport {
    const layoutHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    const keyboardHeight = effectiveKeyboardHeight();
    const viewportTop = viewport?.offsetTop ?? 0;
    const visualBottom = viewport ? viewport.offsetTop + viewport.height : layoutHeight;
    // With KeyboardResize.None, visualViewport generally remains full height
    // on native.  The native event supplies the missing keyboard edge.
    const keyboardTop = keyboardHeight > 0 ? layoutHeight - keyboardHeight : visualBottom;
    const rawBottom = Math.min(visualBottom, keyboardTop) - BOTTOM_BREATHING_ROOM_PX;
    const rawTop = viewportTop + TOP_BREATHING_ROOM_PX;
    // Very small landscape viewports still need a non-negative usable region.
    const bottom = Math.max(rawTop + 1, rawBottom);

    return {
        top: rawTop,
        bottom,
        height: Math.max(1, bottom - rawTop),
        keyboardHeight,
    };
}

function editableTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;

    // `isContentEditable` is more reliable than an attribute selector in
    // WebKit (and covers editors whose contentEditable property was set by a
    // library rather than emitted as literal JSX).
    const editable = target.isContentEditable
        ? (target.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])') ?? target)
        : target.closest<HTMLElement>('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (!editable || editable.hasAttribute('disabled')) return null;
    // A few deliberately compact recipe pickers keep their own measured
    // scroll position. Preserve that explicit contract rather than fighting
    // it from the app-wide guard.
    if (editable.dataset.noKeyboardScroll !== undefined) return null;

    if (editable instanceof HTMLInputElement) {
        // These controls never open a text keyboard, so moving the entire page
        // for a checkbox/file picker is surprising and unnecessary.
        const nonTextTypes = new Set([
            'button',
            'checkbox',
            'color',
            'file',
            'hidden',
            'image',
            'radio',
            'range',
            'reset',
            'submit',
        ]);
        if (nonTextTypes.has(editable.type)) return null;
    }

    return editable;
}

function isScrollable(element: HTMLElement): boolean {
    const styles = window.getComputedStyle(element);
    return (
        (styles.overflowY === 'auto' || styles.overflowY === 'scroll' || styles.overflowY === 'overlay') &&
        element.scrollHeight > element.clientHeight + 1
    );
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
    let parent = element.parentElement;
    while (parent) {
        if (isScrollable(parent)) return parent;
        parent = parent.parentElement;
    }
    return null;
}

function scrollBy(element: HTMLElement, top: number): void {
    if (Math.abs(top) < 1) return;
    if (typeof element.scrollBy === 'function') {
        element.scrollBy({ top, behavior: 'smooth' });
    } else {
        element.scrollTop += top;
    }
}

/**
 * Keeps one editable field in the safe viewport.  Unlike the old
 * `scrollIntoView({ block: 'center' })` approach, this uses the *real*
 * keyboard edge and only scrolls when the field is genuinely obscured.
 */
export function keepEditableAboveKeyboard(target: EventTarget | null): void {
    const element = editableTarget(target);
    if (!element || typeof window === 'undefined') return;

    const field = element.getBoundingClientRect();
    const viewport = getKeyboardViewport();
    const fieldIsAbove = field.top < viewport.top;
    const fieldIsBelow = field.bottom > viewport.bottom;
    if (!fieldIsAbove && !fieldIsBelow) return;

    // Place a focused field in the upper part of the usable area.  This leaves
    // room for iOS's predictive/accessory bar and means a multiline textarea
    // remains readable while it grows.
    const preferredTop = viewport.top + Math.min(40, viewport.height * 0.16);
    const desiredDelta = field.top - preferredTop;
    const scrollParent = findScrollParent(element);

    if (scrollParent) {
        scrollBy(scrollParent, desiredDelta);
        return;
    }

    // Most Thalassa forms live inside an overflow-y-auto panel.  This fallback
    // covers standalone web forms and native modals whose parent becomes
    // scrollable only after a browser layout pass.
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

    // `scrollIntoView` is allowed to be a no-op in a fixed Capacitor shell.
    // A page-level nudge is still useful for normal web documents.
    if (typeof window.scrollBy === 'function') {
        window.scrollBy({ top: desiredDelta, behavior: 'smooth' });
    }
}

function clearScheduledFocusTimers(): void {
    scheduledFocusTimers.forEach((timer) => clearTimeout(timer));
    scheduledFocusTimers = [];
}

/**
 * Schedule a few checks around the keyboard animation.  Multiple focus events
 * (React, native picker and visualViewport can all emit one) collapse to the
 * currently focused element, avoiding stale scrolls after a quick blur.
 */
export function scheduleKeyboardAvoidance(target: EventTarget | null): void {
    const element = editableTarget(target);
    if (!element) return;

    clearScheduledFocusTimers();
    scheduledFocusTimers = FOCUS_SETTLE_DELAYS_MS.map((delay) =>
        setTimeout(() => {
            if (document.activeElement === element || element.contains(document.activeElement)) {
                keepEditableAboveKeyboard(element);
            }
        }, delay),
    );
}

/**
 * Compatibility handler for fields that already explicitly opt in.  All text
 * fields are protected globally at app boot, but keeping this public avoids
 * churn in existing form components and gives lazily mounted surfaces immediate
 * protection before their first global viewport update.
 */
export function scrollInputAboveKeyboard(e: { target: EventTarget | null }): void {
    scheduleKeyboardAvoidance(e.target);
}

function scheduleFocusedElement(): void {
    const focused = document.activeElement;
    if (focused) scheduleKeyboardAvoidance(focused);
}

function startGlobalKeyboardAvoidance(): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

    let disposed = false;
    let keyboardHandles: KeyboardListenerHandle[] = [];

    const updateViewportKeyboard = () => {
        const keyboardHeight = effectiveKeyboardHeight();
        publishKeyboardHeight(keyboardHeight);
        if (keyboardHeight > 0) scheduleFocusedElement();
    };

    const onFocusIn = (event: FocusEvent) => scheduleKeyboardAvoidance(event.target);
    const viewport = window.visualViewport;

    document.addEventListener('focusin', onFocusIn, true);
    viewport?.addEventListener('resize', updateViewportKeyboard);
    viewport?.addEventListener('scroll', updateViewportKeyboard);
    updateViewportKeyboard();

    if (Capacitor.isNativePlatform()) {
        void import('@capacitor/keyboard')
            .then(async ({ Keyboard }) => {
                const onShow = (height: number) => {
                    nativeKeyboardHeight = Math.max(0, height);
                    updateViewportKeyboard();
                };
                const onHide = () => {
                    nativeKeyboardHeight = 0;
                    updateViewportKeyboard();
                };

                // `Will` gives the page a head start, while `Did` covers older
                // plugin/device combinations that only deliver the settled event.
                const handles = await Promise.all([
                    Keyboard.addListener('keyboardWillShow', (info) => onShow(info.keyboardHeight)),
                    Keyboard.addListener('keyboardDidShow', (info) => onShow(info.keyboardHeight)),
                    Keyboard.addListener('keyboardWillHide', onHide),
                    Keyboard.addListener('keyboardDidHide', onHide),
                ]);

                if (disposed) {
                    handles.forEach((handle) => void handle.remove());
                    return;
                }
                keyboardHandles = handles;
            })
            .catch(() => {
                // The visualViewport path is intentionally sufficient on web
                // and for a missing native plugin in a development build.
            });
    }

    return () => {
        disposed = true;
        clearScheduledFocusTimers();
        document.removeEventListener('focusin', onFocusIn, true);
        viewport?.removeEventListener('resize', updateViewportKeyboard);
        viewport?.removeEventListener('scroll', updateViewportKeyboard);
        keyboardHandles.forEach((handle) => void handle.remove());
        keyboardHandles = [];
        nativeKeyboardHeight = 0;
        publishKeyboardHeight(0);
    };
}

function acquireKeyboardGuard(): () => void {
    globalConsumerCount += 1;
    if (!globalCleanup) globalCleanup = startGlobalKeyboardAvoidance();

    let released = false;
    return () => {
        if (released) return;
        released = true;
        globalConsumerCount = Math.max(0, globalConsumerCount - 1);
        if (globalConsumerCount === 0) {
            globalCleanup?.();
            globalCleanup = null;
        }
    };
}

/**
 * Start the app-wide keyboard guard.  It is reference counted so both the app
 * shell and an independently mounted/previewed surface can safely use it.
 */
export function initGlobalKeyboardScroll(): () => void {
    return acquireKeyboardGuard();
}

/**
 * Subscribe to the same native/web keyboard measurement used by the global
 * field guard.  Fixed composers and bottom sheets use this to lift themselves
 * above the keyboard without creating their own divergent Capacitor listener.
 */
export function subscribeKeyboardHeight(subscriber: (height: number) => void): () => void {
    const releaseGuard = acquireKeyboardGuard();
    keyboardHeightSubscribers.add(subscriber);
    publishKeyboardHeight(effectiveKeyboardHeight());
    subscriber(publishedKeyboardHeight);

    return () => {
        keyboardHeightSubscribers.delete(subscriber);
        releaseGuard();
    };
}
