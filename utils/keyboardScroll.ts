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
import { EDITABLE_SELECTOR, FORM_FOCUS_SCOPE, isAvailableForFocus, isTextEntry } from './focusableFields';

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
const scrollReservations = new Map<HTMLElement, { value: string; priority: string; base: number; extra: number }>();
const editorSizes = new Map<HTMLElement, { max: string; min: string; maxPriority: string; minPriority: string }>();

function restoreEditorSize(editor: HTMLElement, saved: NonNullable<ReturnType<typeof editorSizes.get>>): void {
    for (const [property, value, priority] of [
        ['max-height', saved.max, saved.maxPriority],
        ['min-height', saved.min, saved.minPriority],
    ]) {
        if (value) editor.style.setProperty(property, value, priority);
        else editor.style.removeProperty(property);
    }
}

function fitTextArea(element: HTMLElement, height: number): void {
    if (!(element instanceof HTMLTextAreaElement) || effectiveKeyboardHeight() === 0) return;
    const saved = editorSizes.get(element) ?? {
        max: element.style.getPropertyValue('max-height'),
        min: element.style.getPropertyValue('min-height'),
        maxPriority: element.style.getPropertyPriority('max-height'),
        minPriority: element.style.getPropertyPriority('min-height'),
    };
    editorSizes.set(element, saved);
    restoreEditorSize(element, saved);
    const style = window.getComputedStyle(element);
    const limit = Math.max(1, height);
    element.style.setProperty(
        'max-height',
        `${Math.min(parseFloat(style.maxHeight) || Infinity, limit)}px`,
        'important',
    );
    element.style.setProperty('min-height', `${Math.min(parseFloat(style.minHeight) || 0, limit)}px`, 'important');
}

function releaseScrollSpace(exceptFor?: HTMLElement): void {
    for (const [editor, saved] of editorSizes) {
        if (editor === exceptFor) continue;
        restoreEditorSize(editor, saved);
        editorSizes.delete(editor);
    }
    for (const [panel, saved] of scrollReservations) {
        if (exceptFor && panel.contains(exceptFor)) continue;
        if (saved.value) panel.style.setProperty('padding-bottom', saved.value, saved.priority);
        else panel.style.removeProperty('padding-bottom');
        scrollReservations.delete(panel);
    }
}

/** Only reserve the missing scroll travel, on the active panel, while a keyboard is open. */
function reserveScrollSpace(panel: HTMLElement, delta: number): void {
    if (effectiveKeyboardHeight() === 0 || delta <= 0) return;
    const saved = scrollReservations.get(panel) ?? {
        value: panel.style.getPropertyValue('padding-bottom'),
        priority: panel.style.getPropertyPriority('padding-bottom'),
        base: parseFloat(window.getComputedStyle(panel).paddingBottom) || 0,
        extra: 0,
    };
    const remaining = Math.max(0, panel.scrollHeight - panel.clientHeight - panel.scrollTop);
    const missing = Math.max(0, delta - remaining);
    if (missing < 1) return;
    // A single viewport is sufficient to expose even the final field. The cap
    // also prevents repeated layout/animation events growing an unbounded gap.
    saved.extra = Math.min(window.innerHeight, saved.extra + missing);
    scrollReservations.set(panel, saved);
    panel.style.setProperty('padding-bottom', `${saved.base + saved.extra}px`, 'important');
}

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
    if (viewport.scale > 1.05) return 0; // Pinch zoom is not an on-screen keyboard.
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
    const rawTop = viewportTop + Math.min(TOP_BREATHING_ROOM_PX, Math.max(0, (rawBottom - viewportTop) / 4));
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
    if (!editable || !isAvailableForFocus(editable)) return null;
    if ((editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) && editable.readOnly)
        return null;
    // Preserve the explicit escape hatch for specialised editors that own
    // their keyboard positioning rather than fighting their measurements.
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

function isScrollContainer(element: HTMLElement): boolean {
    const styles = window.getComputedStyle(element);
    return styles.overflowY === 'auto' || styles.overflowY === 'scroll' || styles.overflowY === 'overlay';
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
    let parent = element.parentElement;
    while (parent) {
        if (isScrollContainer(parent)) return parent;
        parent = parent.parentElement;
    }
    return null;
}

function scrollBy(element: HTMLElement, top: number): void {
    if (Math.abs(top) < 1) return;
    // INSTANT, never smooth (the "spin", 2026-09-02): the settle timers
    // re-measure at 0/120/360ms, and a smooth scroll is still animating when
    // the next measurement lands — mid-flight geometry produces a wrong
    // delta, the wrong delta launches another smooth scroll, and a
    // multi-field form oscillates. Instant scrolls make every settle pass
    // see the SETTLED truth, so corrections converge and re-runs no-op.
    const originalBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = 'auto';
    if (typeof element.scrollBy === 'function') {
        element.scrollBy({ top, behavior: 'auto' });
    } else {
        element.scrollTop += top;
    }
    element.style.scrollBehavior = originalBehavior;
}

function fieldViewport(element: HTMLElement): KeyboardViewport {
    const viewport = getKeyboardViewport();
    const field = element.getBoundingClientRect();
    let top = viewport.top;
    let bottom = viewport.bottom;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (rect.height > 0 && /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowY)) {
            // A clipped label wrapper is not a viewport; only constrain the
            // usable band when the ancestor can actually contain a whole field.
            if (isScrollContainer(ancestor) || rect.height > field.height + 24) {
                top = Math.max(top, rect.top + 12);
                bottom = Math.min(bottom, rect.bottom - 12);
            }
        }
        for (const child of Array.from(ancestor.children)) {
            if (!(child instanceof HTMLElement) || child.contains(element)) continue;
            const childStyle = window.getComputedStyle(child);
            if (!['sticky', 'fixed'].includes(childStyle.position) || childStyle.top === 'auto') continue;
            const header = child.getBoundingClientRect();
            if (
                header.height > 0 &&
                header.top <= top &&
                header.bottom > top &&
                header.left < field.right &&
                header.right > field.left
            )
                top = header.bottom + 12;
        }
    }
    if (bottom <= top) return viewport;
    return { ...viewport, top, bottom, height: bottom - top };
}

/**
 * Keeps one editable field in the safe viewport.  Unlike the old
 * `scrollIntoView({ block: 'center' })` approach, this uses the *real*
 * keyboard edge and its scroll panel/sticky headers. Focus events request
 * centring; direct visibility checks leave an already-visible field alone.
 */
export function keepEditableAboveKeyboard(target: EventTarget | null, center = false): void {
    const element = editableTarget(target);
    if (!element || typeof window === 'undefined') return;

    releaseScrollSpace(element);
    const viewport = fieldViewport(element);
    fitTextArea(element, viewport.height);
    const field = element.getBoundingClientRect();
    const fieldIsAbove = field.top < viewport.top;
    const fieldIsBelow = field.bottom > viewport.bottom;
    if (!fieldIsAbove && !fieldIsBelow && !(center && viewport.keyboardHeight > 0)) return;

    // Centre in the measured usable band, including the panel's actual
    // sticky header. Large textareas are capped above so their caret can
    // scroll within the editor instead of disappearing behind the keyboard.
    const preferredTop =
        field.height >= viewport.height ? viewport.top : viewport.top + (viewport.height - field.height) / 2;
    const desiredDelta = field.top - preferredTop;
    const scrollParent = findScrollParent(element);

    if (scrollParent) {
        reserveScrollSpace(scrollParent, desiredDelta);
        scrollBy(scrollParent, desiredDelta);
        // Nested panels may reach their own scroll limit. Let an outer panel
        // expose the field too, rather than abandoning it behind a fixed edge.
        let outer = findScrollParent(scrollParent);
        while (
            outer &&
            outer !== document.documentElement &&
            outer !== document.body &&
            outer !== document.getElementById('root')
        ) {
            // Once a field owns an inner scroller, never add blank scroll
            // space to the app/document roots to rescue an undersized panel.
            // That can scroll the entire chat (including its header) away.
            const current = element.getBoundingClientRect();
            const safe = fieldViewport(element);
            const delta =
                current.bottom > safe.bottom
                    ? current.bottom - safe.bottom
                    : current.top < safe.top
                      ? current.top - safe.top
                      : 0;
            if (Math.abs(delta) < 1) break;
            reserveScrollSpace(outer, delta);
            scrollBy(outer, delta);
            outer = findScrollParent(outer);
        }
        return;
    }

    // Most Thalassa forms live inside an overflow-y-auto panel.  This fallback
    // covers standalone web forms and native modals whose parent becomes
    // scrollable only after a browser layout pass.
    element.scrollIntoView?.({ behavior: 'auto', block: 'nearest', inline: 'nearest' });

    // `scrollIntoView` is allowed to be a no-op in a fixed Capacitor shell.
    // A page-level nudge is still useful for normal web documents.
    if (typeof window.scrollBy === 'function') {
        const remaining = element.getBoundingClientRect().top - preferredTop;
        if (Math.abs(remaining) >= 1) window.scrollBy({ top: remaining, behavior: 'auto' });
    }
}

/* ── RETURN-KEY NAVIGATION (Shane 2026-09-02: "when you press … either the
 * keyboard disappears or the next box becomes focused in the middle of the
 * screen") ──
 *
 * Use the nearest form/dialog boundary, falling back to the scroll panel.
 * Return walks writable fields in DOM order, never into a background dialog.
 * The last field dismisses the keyboard, or preserves a real form's submit.
 * Runs in the BUBBLE phase and respects defaultPrevented, so the handful of
 * components with their own Enter behaviour (search boxes, send buttons)
 * always win. Textareas and contenteditables keep Enter for newlines.
 */
function clusterEditables(from: HTMLElement): HTMLElement[] {
    const scope = from.closest<HTMLElement>(FORM_FOCUS_SCOPE);
    const cluster = scope ?? findScrollParent(from) ?? document.body;
    const candidates = Array.from(cluster.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR));
    return candidates.filter((el) => {
        if (editableTarget(el) !== el) return false;
        if (!isTextEntry(el)) return false;
        if (el.closest(FORM_FOCUS_SCOPE) !== scope) return false;
        if (el.getClientRects().length === 0) return false; // display:none / detached
        return true;
    });
}

function nextEditableInCluster(current: HTMLElement): HTMLElement | null {
    const fields = clusterEditables(current);
    const index = fields.indexOf(current);
    if (index < 0) return null;
    return fields[index + 1] ?? null;
}

function isSingleLineTextInput(el: HTMLElement | null): el is HTMLInputElement {
    return el instanceof HTMLInputElement;
}

function labelReturnKey(target: EventTarget | null): void {
    const element = editableTarget(target);
    if (!isSingleLineTextInput(element) || !isTextEntry(element)) return;
    if (element.type === 'search' || element.getAttribute('role') === 'combobox') return;
    // Respect an author-set hint; only manage the ones we labelled.
    if (element.enterKeyHint && element.enterKeyHint !== element.dataset.thalassaEnterHint) return;
    const hint = nextEditableInCluster(element) ? 'next' : 'done';
    element.dataset.thalassaEnterHint = hint;
    element.enterKeyHint = hint;
}

function onReturnKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const element = editableTarget(event.target);
    if (!isSingleLineTextInput(element)) return;
    if (!isTextEntry(element)) return;
    if (element.type === 'search' || element.getAttribute('role') === 'combobox') return;
    const authoredHint = element.enterKeyHint !== element.dataset.thalassaEnterHint ? element.enterKeyHint : '';
    if (['search', 'send', 'go', 'enter'].includes(authoredHint)) return;
    const next = authoredHint === 'done' ? null : nextEditableInCluster(element);
    // A real form owns submission from its final field; do not swallow its
    // submit event. Explicit Done remains a keyboard-dismiss action.
    if (!next && element.form && authoredHint !== 'done') return;
    event.preventDefault();
    if (next) {
        next.focus({ preventScroll: true });
        scheduleKeyboardAvoidance(next);
    } else {
        element.blur();
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
                keepEditableAboveKeyboard(element, true);
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
        else releaseScrollSpace();
    };

    const onFocusIn = (event: FocusEvent) => {
        labelReturnKey(event.target);
        scheduleKeyboardAvoidance(event.target);
    };
    const viewport = window.visualViewport;

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onReturnKey, false);
    viewport?.addEventListener('resize', updateViewportKeyboard);
    viewport?.addEventListener('scroll', updateViewportKeyboard);
    window.addEventListener('resize', updateViewportKeyboard);
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
        document.removeEventListener('keydown', onReturnKey, false);
        viewport?.removeEventListener('resize', updateViewportKeyboard);
        viewport?.removeEventListener('scroll', updateViewportKeyboard);
        window.removeEventListener('resize', updateViewportKeyboard);
        keyboardHandles.forEach((handle) => void handle.remove());
        keyboardHandles = [];
        nativeKeyboardHeight = 0;
        releaseScrollSpace();
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
