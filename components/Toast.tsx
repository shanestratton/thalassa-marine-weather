/**
 * Toast Notification System — Global Event-Based
 *
 * Provides a singleton toast manager that can be triggered from anywhere
 * (components, services, callbacks) without prop-drilling or context providers.
 *
 * Usage:
 *   import { toast } from '../components/Toast';
 *   toast.success('Route saved to logbook');
 *   toast.error('Failed to export GPX');
 *   toast.persistentError('Safety action failed — user acknowledgement required');
 *   toast.info('Wind data loading…');
 *
 * Mount <ToastPortal /> once in App.tsx.
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { FONT, SIZE } from '../styles/typeScale';
import { CheckIcon, InfoIcon, XIcon } from './icons/UIIcons';
import { triggerHaptic } from '../utils/system';

// ── Types ──────────────────────────────────────────────────────────
export type ToastType = 'success' | 'error' | 'loading' | 'info';

interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
    action?: { label: string; onClick: () => void };
    duration: number; // 0 = manual close
}

// ── Global Event Bus ───────────────────────────────────────────────
type Listener = (item: ToastItem) => void;
type DismissListener = (id?: number) => void;
const listeners: Set<Listener> = new Set();
const dismissListeners: Set<DismissListener> = new Set();
// Native safety events can arrive while React is still mounting (or while the
// legal disclaimer is in front of App). Keep a small in-memory backlog so an
// early Watch-MOB rejection is shown when ToastPortal becomes available rather
// than disappearing before the user can see it.
let pendingItems: ToastItem[] = [];
let nextId = 1;

function appendWithSafetyPriority(items: ToastItem[], item: ToastItem): ToastItem[] {
    const next = [...items, item];
    if (next.length <= 5) return next;
    // Indefinite alerts/loading states require explicit user resolution. Drop
    // the oldest transient message first so a native safety warning cannot be
    // displaced by an ordinary burst of status toasts while the app resumes.
    const transientIndex = next.findIndex((candidate) => candidate.duration > 0);
    next.splice(transientIndex >= 0 ? transientIndex : 0, 1);
    return next;
}

function emit(
    message: string,
    type: ToastType,
    duration: number,
    action?: { label: string; onClick: () => void },
): number {
    const id = nextId++;
    const item: ToastItem = { id, message, type, duration, action };
    if (listeners.size === 0) {
        pendingItems = appendWithSafetyPriority(pendingItems, item);
    } else {
        listeners.forEach((fn) => fn(item));
    }
    return id;
}

/** Global toast API — call from anywhere */
export const toast = {
    success: (msg: string, action?: { label: string; onClick: () => void }) => emit(msg, 'success', 3000, action),
    error: (msg: string, duration = 4000) => emit(msg, 'error', duration),
    persistentError: (
        msg: string,
        action: { label: string; onClick: () => void } = { label: 'Dismiss', onClick: () => undefined },
    ) => emit(msg, 'error', 0, action),
    info: (msg: string, duration = 3000) => emit(msg, 'info', duration),
    loading: (msg: string) => emit(msg, 'loading', 0),
    dismiss: (id: number) => {
        pendingItems = pendingItems.filter((item) => item.id !== id);
        dismissListeners.forEach((fn) => fn(id));
    },
    clear: () => {
        pendingItems = [];
        dismissListeners.forEach((fn) => fn());
    },
};

// ── Single Toast Component ─────────────────────────────────────────
// Stroke icons, not unicode glyphs: ℹ and ⟳ fell back to thin or emoji
// renderings across iOS fonts, beside the app's line icons everywhere else.
const ToastIcon: React.FC<{ type: ToastType }> = ({ type }) => {
    if (type === 'loading') {
        return <span className="block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
    }
    const Icon = type === 'success' ? CheckIcon : type === 'error' ? XIcon : InfoIcon;
    return <Icon className="h-4 w-4" />;
};

const COLORS: Record<ToastType, { bg: string; border: string; glow: string }> = {
    success: {
        // emerald-700, not -500: white on the lighter green measured 2.8:1
        // (UX scorecard 2026-09-25). 5.5:1 here, in both display modes.
        bg: 'rgba(4, 120, 87, 0.96)',
        border: 'rgba(52, 211, 153, 0.5)',
        glow: '0 8px 32px rgba(16, 185, 129, 0.3)',
    },
    error: {
        // red-700 for the same reason: white on red-500 was 3.8:1.
        bg: 'rgba(185, 28, 28, 0.96)',
        border: 'rgba(248, 113, 113, 0.5)',
        glow: '0 8px 32px rgba(239, 68, 68, 0.3)',
    },
    info: {
        bg: 'rgba(30, 41, 59, 0.95)',
        border: 'rgba(56, 189, 248, 0.3)',
        glow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    },
    loading: {
        bg: 'rgba(30, 41, 59, 0.95)',
        border: 'rgba(99, 102, 241, 0.3)',
        glow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    },
};

const SingleToast: React.FC<{ item: ToastItem; onClose: (id: number) => void; docked?: boolean }> = ({
    item,
    onClose,
    docked = false,
}) => {
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);
    const closingRef = useRef(false);
    const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const beginClose = useCallback(() => {
        if (closingRef.current) return;
        closingRef.current = true;
        setExiting(true);
        removeTimerRef.current = setTimeout(() => onClose(item.id), 300);
    }, [item.id, onClose]);

    useEffect(() => {
        // Animate in
        const frame = requestAnimationFrame(() => setVisible(true));
        // Physical feedback on arrival — light for the good/neutral news,
        // medium for errors. Loading toasts stay silent (they resolve into
        // one of the others).
        if (item.type === 'success' || item.type === 'info') {
            triggerHaptic('light');
        } else if (item.type === 'error') {
            triggerHaptic('medium');
        }
        return () => cancelAnimationFrame(frame);
    }, [item.type]);

    useEffect(() => {
        if (item.duration <= 0) return;
        const timer = setTimeout(beginClose, item.duration);
        return () => clearTimeout(timer);
    }, [beginClose, item.duration]);

    useEffect(
        () => () => {
            if (removeTimerRef.current) clearTimeout(removeTimerRef.current);
        },
        [],
    );

    const colors = COLORS[item.type];

    return (
        <div
            role={item.type === 'error' ? 'alert' : 'status'}
            aria-live={item.type === 'error' ? 'assertive' : 'polite'}
            style={{
                // Docked above a bottom bar, the toast rises from it instead of dropping in.
                transform:
                    visible && !exiting ? 'translateY(0) scale(1)' : `translateY(${docked ? 12 : -12}px) scale(0.95)`,
                opacity: visible && !exiting ? 1 : 0,
                transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 16, // rounded-2xl — matches the app's floating-card radius
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 260,
                maxWidth: 380,

                boxShadow: colors.glow,
                pointerEvents: 'auto',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    display: 'inline-flex',
                    flexShrink: 0,
                    // White in both palettes: the toast is a saturated slab, and by day the
                    // inherited page ink made the tick 3.5:1 on emerald and ✕ 2.7:1 on red.
                    color: '#ffffff',
                }}
            >
                <ToastIcon type={item.type} />
            </span>
            <span
                style={{
                    flex: 1,
                    color: '#ffffff',
                    fontFamily: FONT.ui,
                    fontSize: SIZE.subhead,
                    fontWeight: 600,
                    lineHeight: 1.3,
                    letterSpacing: '0.01em',
                }}
            >
                {item.message}
            </span>
            {item.action && (
                <button
                    aria-label={item.action.label}
                    onClick={() => {
                        try {
                            item.action!.onClick();
                        } finally {
                            beginClose();
                        }
                    }}
                    style={{
                        background: 'rgba(255,255,255,0.15)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: 8,
                        minHeight: 44,
                        padding: '0 14px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: '#ffffff',
                        fontFamily: FONT.ui,
                        fontSize: SIZE.body,
                        fontWeight: 700,
                        // Sentence case like every other button (UX scorecard run 7).
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
                >
                    {item.action.label}
                </button>
            )}
        </div>
    );
};

// ── Placement ──────────────────────────────────────────────────────
/**
 * Where the stack's top edge goes: just below the page's own header (the
 * brand <header> and any PageHeader, which carries data-page-header). A
 * fixed top of 60 px landed toasts on the brand row and the breadcrumb/back
 * row for 3–4 s: "40 suggested tasks added" sat over SHIP'S OFFICE ›
 * MAINTENANCE and the only way out (UX scorecard run 6).
 *
 * Returns 0 — the old safe-area-aware top — while a dialog is open, since the
 * dim already covers the header and lower down the toast would sit on the
 * dialog's title; and when no header is on screen (the chart).
 */
export function measureToastAnchor(): number {
    if (typeof document === 'undefined' || typeof window === 'undefined') return 0;
    const onScreen = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.left < window.innerWidth;
    };
    const dialogs = document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]');
    if (Array.from(dialogs).some(onScreen)) return 0;
    const ceiling = window.innerHeight * 0.4;
    let bottom = 0;
    document.querySelectorAll('header, [data-page-header]').forEach((el) => {
        if (!onScreen(el)) return;
        const r = el.getBoundingClientRect();
        // A header that starts low on the screen is not the page's top chrome.
        if (r.top < ceiling) bottom = Math.max(bottom, r.bottom);
    });
    return Math.round(Math.min(bottom, ceiling));
}

/**
 * The top edge of a bottom action bar the stack should sit on, or null.
 *
 * A page whose only action is a full-width bar at its foot (TapToAction, which
 * carries data-toast-dock) gets its toasts docked just above that bar: a top
 * toast covered the first card for 3–4 s — '40 suggested tasks added' sat on
 * the Engine hours card the '1 needs hours' chip asks you to tap (UX scorecard
 * run 7). Null while a dialog is open or when no such bar is on screen, so
 * every other page keeps the top placement.
 */
export function measureToastDock(): number | null {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const onScreen = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    };
    const dialogs = document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]');
    if (Array.from(dialogs).some(onScreen)) return null;
    let top: number | null = null;
    document.querySelectorAll('[data-toast-dock]').forEach((el) => {
        if (!onScreen(el)) return;
        const r = el.getBoundingClientRect();
        // Only a bar in the lower half of the screen is a bottom bar.
        if (r.top > window.innerHeight * 0.5) top = top === null ? r.top : Math.min(top, r.top);
    });
    return top === null ? null : Math.round(top);
}

// ── Portal — Mount once in App.tsx ─────────────────────────────────
export const ToastPortal: React.FC = () => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const [anchorTop, setAnchorTop] = useState(0);
    const [dockTop, setDockTop] = useState<number | null>(null);

    // Re-measured whenever the stack changes, before paint, so a toast never
    // flashes over the header first.
    useLayoutEffect(() => {
        if (toasts.length === 0) return;
        setAnchorTop(measureToastAnchor());
        setDockTop(measureToastDock());
    }, [toasts]);

    useEffect(() => {
        const handler: Listener = (item) => {
            setToasts((prev) => appendWithSafetyPriority(prev, item));
        };
        listeners.add(handler);
        if (pendingItems.length > 0) {
            const queued = pendingItems;
            pendingItems = [];
            setToasts((prev) => queued.reduce(appendWithSafetyPriority, prev));
        }
        const dismissHandler: DismissListener = (id) => {
            setToasts((prev) => (id === undefined ? [] : prev.filter((item) => item.id !== id)));
        };
        dismissListeners.add(dismissHandler);
        return () => {
            listeners.delete(handler);
            dismissListeners.delete(dismissHandler);
        };
    }, []);

    const removeToast = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    if (toasts.length === 0) return null;

    const docked = dockTop !== null && typeof window !== 'undefined';

    return (
        <div
            data-toast-stack={docked ? 'docked' : 'top'}
            style={{
                position: 'fixed',
                ...(docked
                    ? { bottom: `${window.innerHeight - (dockTop as number) + 8}px` }
                    : { top: `max(60px, calc(env(safe-area-inset-top) + 8px), ${anchorTop + 8}px)` }),
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                alignItems: 'center',
                pointerEvents: 'none',
            }}
        >
            {toasts.map((t) => (
                <SingleToast key={t.id} item={t} onClose={removeToast} docked={docked} />
            ))}
        </div>
    );
};

// ── Legacy useToast hook (backwards-compatible) ────────────────────
export const useToast = () => {
    const showToast = (message: string, type: ToastType = 'info', duration?: number) => {
        return emit(message, type, duration ?? 3000);
    };

    const hideToast = (id: number) => {
        toast.dismiss(id);
    };

    const ToastContainer = () => null; // Now handled by ToastPortal

    return {
        showToast,
        hideToast,
        ToastContainer,
        success: (msg: string, duration?: number) => showToast(msg, 'success', duration),
        error: (msg: string, duration?: number) => showToast(msg, 'error', duration),
        loading: (msg: string) => showToast(msg, 'loading', 0),
        info: (msg: string, duration?: number) => showToast(msg, 'info', duration),
    };
};
