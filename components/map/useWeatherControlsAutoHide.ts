import { useCallback, useEffect, useRef, type HTMLAttributes } from 'react';

export const WEATHER_CONTROLS_IDLE_MS = 6_000;

/** Declutter presentation only: hiding controls must never stop the map's playback. */
export function useWeatherControlsAutoHide({
    enabled,
    hidden,
    contextKey,
    onHiddenChange,
}: {
    enabled: boolean;
    hidden: boolean;
    contextKey: string;
    onHiddenChange: (hidden: boolean) => void;
}) {
    const panelRef = useRef<HTMLElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const latest = useRef({ enabled, hidden, onHiddenChange });
    latest.current = { enabled, hidden, onHiddenChange };
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pointers = useRef(new Set<number>());
    const pointerIntent = useRef(false);
    const keyboardFocus = useRef(false);
    const editing = useRef(false);
    const restoreFocus = useRef(false);

    const clearTimer = useCallback(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
    }, []);
    const hide = useCallback(() => {
        clearTimer();
        restoreFocus.current = !!panelRef.current?.contains(document.activeElement);
        latest.current.onHiddenChange(true);
    }, [clearTimer]);
    const arm = useCallback(() => {
        clearTimer();
        if (
            !latest.current.enabled ||
            latest.current.hidden ||
            pointers.current.size ||
            keyboardFocus.current ||
            editing.current ||
            document.hidden
        )
            return;
        timer.current = setTimeout(() => {
            timer.current = null;
            if (
                latest.current.enabled &&
                !latest.current.hidden &&
                !pointers.current.size &&
                !keyboardFocus.current &&
                !editing.current
            )
                hide();
        }, WEATHER_CONTROLS_IDLE_MS);
    }, [clearTimer, hide]);
    const show = useCallback(() => {
        restoreFocus.current = false;
        latest.current.onHiddenChange(false);
    }, []);
    const isEditable = (target: EventTarget | null) =>
        target instanceof Element &&
        !!target.closest(
            'select, textarea, input:not([type="range"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]',
        );

    useEffect(() => {
        if (hidden && restoreFocus.current) {
            restoreFocus.current = false;
            triggerRef.current?.focus({ preventScroll: true });
        }
        if (hidden || !enabled) {
            pointers.current.clear();
            keyboardFocus.current = false;
            editing.current = false;
        }
        arm();
        return clearTimer;
    }, [enabled, hidden, contextKey, arm, clearTimer]);

    useEffect(() => {
        if (!enabled || hidden) return;
        const onPointerDown = (event: PointerEvent) => {
            pointerIntent.current = true;
            const inside = !!(event.target instanceof Node && panelRef.current?.contains(event.target));
            const wasHeld = keyboardFocus.current || editing.current;
            keyboardFocus.current = false;
            editing.current = inside && isEditable(event.target);
            if (inside) {
                pointers.current.add(event.pointerId);
                clearTimer();
            } else if (wasHeld) arm();
        };
        const release = (event: PointerEvent) => {
            if (pointers.current.delete(event.pointerId)) arm();
        };
        const keyDown = (event: KeyboardEvent) => {
            pointerIntent.current = false;
            if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
                keyboardFocus.current = true;
                clearTimer();
            }
        };
        const visibility = () => {
            pointers.current.clear();
            if (document.hidden) clearTimer();
            else arm();
        };
        const blur = () => {
            pointers.current.clear();
            clearTimer();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', release, true);
        document.addEventListener('pointercancel', release, true);
        document.addEventListener('keydown', keyDown, true);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('blur', blur);
        window.addEventListener('focus', arm);
        return () => {
            clearTimer();
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointerup', release, true);
            document.removeEventListener('pointercancel', release, true);
            document.removeEventListener('keydown', keyDown, true);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('blur', blur);
            window.removeEventListener('focus', arm);
        };
    }, [enabled, hidden, arm, clearTimer]);

    const interactionProps: HTMLAttributes<HTMLElement> = {
        onClickCapture: arm,
        onInputCapture: arm,
        onChangeCapture: arm,
        onScrollCapture: arm,
        onWheelCapture: arm,
        onFocusCapture: (event) => {
            keyboardFocus.current = !pointerIntent.current;
            editing.current = isEditable(event.target);
            arm();
        },
        onBlurCapture: (event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            keyboardFocus.current = false;
            editing.current = false;
            arm();
        },
    };
    return { panelRef, triggerRef, interactionProps, hide, show };
}
