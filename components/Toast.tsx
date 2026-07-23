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
 *   toast.info('Wind data loading…');
 *
 * Mount <ToastPortal /> once in App.tsx.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FONT, SIZE } from '../styles/typeScale';
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
let nextId = 1;

function emit(
    message: string,
    type: ToastType,
    duration: number,
    action?: { label: string; onClick: () => void },
): number {
    const id = nextId++;
    const item: ToastItem = { id, message, type, duration, action };
    listeners.forEach((fn) => fn(item));
    return id;
}

/** Global toast API — call from anywhere */
export const toast = {
    success: (msg: string, action?: { label: string; onClick: () => void }) => emit(msg, 'success', 3000, action),
    error: (msg: string, duration = 4000) => emit(msg, 'error', duration),
    info: (msg: string, duration = 3000) => emit(msg, 'info', duration),
    loading: (msg: string) => emit(msg, 'loading', 0),
    dismiss: (id: number) => dismissListeners.forEach((fn) => fn(id)),
    clear: () => dismissListeners.forEach((fn) => fn()),
};

// ── Single Toast Component ─────────────────────────────────────────
const ICONS: Record<ToastType, string> = {
    success: '✓',
    error: '✕',
    loading: '⟳',
    info: 'ℹ',
};

const COLORS: Record<ToastType, { bg: string; border: string; glow: string }> = {
    success: {
        bg: 'rgba(16, 185, 129, 0.95)',
        border: 'rgba(52, 211, 153, 0.5)',
        glow: '0 8px 32px rgba(16, 185, 129, 0.3)',
    },
    error: {
        bg: 'rgba(239, 68, 68, 0.95)',
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

const SingleToast: React.FC<{ item: ToastItem; onClose: (id: number) => void }> = ({ item, onClose }) => {
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
                transform: visible && !exiting ? 'translateY(0) scale(1)' : 'translateY(-12px) scale(0.95)',
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
                    fontSize: 16,
                    flexShrink: 0,
                    animation: item.type === 'loading' ? 'spin 1s linear infinite' : undefined,
                    filter: 'brightness(1.3)',
                }}
            >
                {ICONS[item.type]}
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
                        padding: '4px 10px',
                        color: '#ffffff',
                        fontFamily: FONT.ui,
                        fontSize: SIZE.body,
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
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

// ── Portal — Mount once in App.tsx ─────────────────────────────────
export const ToastPortal: React.FC = () => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    useEffect(() => {
        const handler: Listener = (item) => {
            setToasts((prev) => [...prev.slice(-4), item]); // Keep max 5
        };
        listeners.add(handler);
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

    return (
        <div
            style={{
                position: 'fixed',
                top: 'max(60px, calc(env(safe-area-inset-top) + 8px))',
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
                <SingleToast key={t.id} item={t} onClose={removeToast} />
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
