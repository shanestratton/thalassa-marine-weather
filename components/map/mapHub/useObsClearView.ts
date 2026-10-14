/**
 * Obs's clear view (129-13): every control off the chart so the skipper can
 * see it, and back again, with no new button.
 *
 * Shane, 2026-10-14: "We need a way to clear everything off the screen so we
 * can actually see the screen. A toggle of some kind. One that you can turn
 * on or off at the press of a (not another button)." And: "Maybe the
 * scrubber button. As that should stay."
 *
 * Ways in and out:
 *  - two fingers held still on the chart and lifted (clearView/twoFingerHold.ts:
 *    a two-finger TAP is Mapbox's zoom-out), on every chart view, with a
 *    weather layer up or none. Shane chose it on 14 Oct (129-13b): "Two-finger
 *    hold (Recommended)", not a long press on the scrubber and not both.
 *    Preferences can switch it off;
 *  - H on a keyboard toggles, Escape brings the controls back;
 *  - a hidden button for VoiceOver, "Clear the screen", and in the clear view
 *    "Controls hidden. Double tap to show" takes the focus (ObsClearViewChrome).
 *
 * Out, too: one tap anywhere on the chart, which is spent on that and does
 * not also open the weather readout (a long press still drops its pin); any
 * alarm (AlarmAudioService.onAlarm); MOB, the picker, plotting, Inspect or a
 * passage point taking the chart; leaving Obs; the app going to the
 * background. Never saved: Obs always opens with its controls.
 *
 * What hides and what stays is index.css ([data-obs-clear-view='on']): the
 * chart and what is drawn on it, MOB, the credits ([data-map-credit]), the
 * Mapbox wordmark and attribution, the scrubber, an urgent threat chip and
 * anything marked data-clear-view-keep stay. The scrubber's pill is kept,
 * and its tap still opens the timeline, but it is not a switch. The tab bar
 * hides too, except in split view, where it is The Glass's as well.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { AlarmAudioService } from '../../../services/AlarmAudioService';
import { triggerHaptic } from '../../../utils/system';
import { TwoFingerHold, type HoldPoint } from '../clearView/twoFingerHold';

/** Once per device: "Tap anywhere to bring the controls back". */
export const CLEAR_VIEW_HINT_KEY = 'thalassa.obsClearView.hintSeen';
export const CLEAR_VIEW_HINT_MS = 4_000;
/** On <html> while the controls are hidden outside split view: the tab bar goes too. */
export const CLEAR_VIEW_ROOT_CLASS = 'thalassa-obs-clear-view';
/** useMapInit's long press: a press this long dropped a pin, and its click is the pin's. */
const LONG_PRESS_MS = 500;
/** Further than this between press and click is a drag, which Mapbox already ignores. */
const TAP_SLOP_PX = 10;
/** Clicks that are the kept controls' own. */
const KEPT = '[data-clear-view-keep], [data-map-credit]';

export interface ObsClearView {
    /** The controls are hidden. */
    on: boolean;
    /** Obs is on screen with its own controls and nothing owns the chart: it can clear. */
    available: boolean;
    /** The first time on this device, the line saying how to come back. */
    hint: boolean;
    hide: () => void;
    show: () => void;
    toggle: () => void;
}

export interface UseObsClearViewOptions {
    /** The box holding the chart and every control over it (MapHub's chart frame). */
    frameRef: RefObject<HTMLElement | null>;
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    /** Obs is on screen with its own controls: not Plan, an embed, the picker or a pin view. */
    available: boolean;
    /** MOB, the picker, plotting, Inspect or a passage point has the chart. */
    modeOwnsChart: boolean;
    /** Preferences → Chart, "Two-finger hold clears the chart" (default on). */
    holdGesture: boolean;
}

/** A sheet, dialog, popup or the layer menu is open: the gesture and H leave the chart alone. */
export function chartBusy(frame: HTMLElement | null): boolean {
    const shown = (el: Element) => el.getClientRects().length > 0;
    const open = document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]');
    if (Array.from(open).some(shown)) return true;
    if (!frame) return false;
    return Array.from(frame.querySelectorAll('.mapboxgl-popup, .radial-helm-open, .tide-station-detail-overlay')).some(
        shown,
    );
}

function isEditable(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    );
}

function readSeen(): boolean {
    try {
        return window.localStorage.getItem(CLEAR_VIEW_HINT_KEY) === '1';
    } catch {
        return true;
    }
}

function writeSeen(): void {
    try {
        window.localStorage.setItem(CLEAR_VIEW_HINT_KEY, '1');
    } catch {
        /* private mode: the hint may show again */
    }
}

export function useObsClearView({
    frameRef,
    mapRef,
    mapReady,
    available,
    modeOwnsChart,
    holdGesture,
}: UseObsClearViewOptions): ObsClearView {
    const allowed = available && !modeOwnsChart;
    const [on, setOn] = useState(false);
    const [hint, setHint] = useState(false);
    const allowedRef = useRef(allowed);
    allowedRef.current = allowed;
    const onRef = useRef(on);
    onRef.current = on;

    const show = useCallback(() => setOn(false), []);
    const hide = useCallback(() => {
        if (allowedRef.current) setOn(true);
    }, []);
    const toggle = useCallback(() => {
        if (onRef.current) setOn(false);
        else if (allowedRef.current) setOn(true);
    }, []);

    // A mode took the chart, or Obs went away: the controls come back.
    useEffect(() => {
        if (!allowed) setOn(false);
    }, [allowed]);

    // Any alarm, and the app going to the background, give them back too.
    useEffect(() => AlarmAudioService.onAlarm(() => setOn(false)), []);
    useEffect(() => {
        const away = () => {
            if (document.hidden) setOn(false);
        };
        document.addEventListener('visibilitychange', away);
        window.addEventListener('pagehide', show);
        return () => {
            document.removeEventListener('visibilitychange', away);
            window.removeEventListener('pagehide', show);
        };
    }, [show]);

    // The tab bar: hidden with the controls, except in split view, where The Glass needs it.
    useEffect(() => {
        if (!on) return undefined;
        const split = frameRef.current?.closest('[data-split-pane="chart"]') != null;
        if (split) return undefined;
        const root = document.documentElement;
        root.classList.add(CLEAR_VIEW_ROOT_CLASS);
        return () => root.classList.remove(CLEAR_VIEW_ROOT_CLASS);
    }, [on, frameRef]);

    // The first time on this device: one line on how to come back.
    useEffect(() => {
        if (!on) {
            setHint(false);
            return undefined;
        }
        if (readSeen()) return undefined;
        writeSeen();
        setHint(true);
        const timer = window.setTimeout(() => setHint(false), CLEAR_VIEW_HINT_MS);
        return () => window.clearTimeout(timer);
    }, [on]);

    // One tap anywhere brings the controls back, and is spent doing it: caught
    // on its way down, so the chart never sees it (no weather readout, no
    // popup). The long press's own click, a drag, and the kept controls' own
    // taps (MOB, the scrubber, a credit's ⓘ) go on as usual.
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame || !on) return undefined;
        let press: { x: number; y: number; at: number } | null = null;
        const down = (event: PointerEvent) => {
            if (event.isPrimary !== false) press = { x: event.clientX, y: event.clientY, at: performance.now() };
        };
        const click = (event: MouseEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(KEPT)) return;
            const p = press;
            press = null;
            if (
                p &&
                (performance.now() - p.at >= LONG_PRESS_MS ||
                    Math.hypot(event.clientX - p.x, event.clientY - p.y) > TAP_SLOP_PX)
            )
                return;
            event.preventDefault();
            event.stopPropagation();
            setOn(false);
        };
        frame.addEventListener('pointerdown', down, true);
        frame.addEventListener('click', click, true);
        return () => {
            frame.removeEventListener('pointerdown', down, true);
            frame.removeEventListener('click', click, true);
        };
    }, [on, frameRef]);

    // H toggles and Escape brings the controls back, from the chart, never from a text field.
    useEffect(() => {
        if (!allowed && !on) return undefined;
        const key = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isEditable(event.target)) return;
            const frame = frameRef.current;
            const focus = document.activeElement;
            const onChart = !focus || focus === document.body || !!frame?.contains(focus);
            if (event.key === 'Escape' && onRef.current) {
                event.preventDefault();
                setOn(false);
                return;
            }
            if ((event.key === 'h' || event.key === 'H') && !event.repeat && onChart) {
                if (!onRef.current && (!allowedRef.current || chartBusy(frame))) return;
                event.preventDefault();
                toggle();
            }
        };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [allowed, on, frameRef, toggle]);

    // Two fingers held still on the chart, decided as they lift, on the
    // events' own times (clearView/twoFingerHold.ts).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !holdGesture || !allowed) return undefined;
        const container = map.getContainer();
        const hold = new TwoFingerHold();
        const points = (list: TouchList): HoldPoint[] =>
            Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
        const at = (event: Event) => (Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now());
        const touch = (event: TouchEvent) => {
            if (!hold.touches(points(event.touches), at(event))) return;
            if (!allowedRef.current) return;
            if (!onRef.current && chartBusy(frameRef.current)) return;
            triggerHaptic('medium');
            toggle();
        };
        const cancelTouch = (event: TouchEvent) => {
            hold.cancel();
            hold.touches(points(event.touches), at(event));
        };
        // A pinch, a turn or a tilt the skipper began: not a hold. The
        // camera's own moves (following the boat, a storm's centre lock) carry
        // no originalEvent and leave it be.
        const gesture = (event: unknown) => {
            if ((event as { originalEvent?: unknown } | undefined)?.originalEvent) hold.cancel();
        };
        container.addEventListener('touchstart', touch, { passive: true });
        container.addEventListener('touchmove', touch, { passive: true });
        container.addEventListener('touchend', touch, { passive: true });
        container.addEventListener('touchcancel', cancelTouch, { passive: true });
        map.on('zoomstart', gesture);
        map.on('rotatestart', gesture);
        map.on('pitchstart', gesture);
        return () => {
            container.removeEventListener('touchstart', touch);
            container.removeEventListener('touchmove', touch);
            container.removeEventListener('touchend', touch);
            container.removeEventListener('touchcancel', cancelTouch);
            map.off('zoomstart', gesture);
            map.off('rotatestart', gesture);
            map.off('pitchstart', gesture);
        };
    }, [mapRef, mapReady, holdGesture, allowed, frameRef, toggle]);

    return { on, available: allowed, hint, hide, show, toggle };
}
