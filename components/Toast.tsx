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

import React, { useEffect, useState, useCallback } from 'react';

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
const listeners: Set<Listener> = new Set();
let nextId = 1;

function emit(message: string, type: ToastType, duration: number, action?: { label: string; onClick: () => void }): number {
    const id = nextId++;
    const item: ToastItem = { id, message, type, duration, action };
    listeners.forEach(fn => fn(item));
    return id;
}

/** Global toast API — call from anywhere */
export const toast = {
    success: (msg: string, action?: { label: string; onClick: () => void }) => emit(msg, 'success', 3000, action),
    error: (msg: string, duration = 4000) => emit(msg, 'error', duration),
    info: (msg: string, duration = 3000) => emit(msg, 'info', duration),
    loading: (msg: string) => emit(msg, 'loading', 0),
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

const SingleToast: React.FC<{ item: ToastItem; onClose: () => void }> = ({ item, onClose }) => {
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);

    useEffect(() => {
        // Animate in
        requestAnimationFrame(() => setVisible(true));
    }, []);

    useEffect(() => {
        if (item.duration > 0) {
            const timer = setTimeout(() => {
                setExiting(true);
                setTimeout(onClose, 300);
            }, item.duration);
            return () => clearTimeout(timer);
        }
    }, [item.duration, onClose]);

    const colors = COLORS[item.type];

    return (
        <div
            role="alert"
            aria-live="assertive"
            style={{
                transform: visible && !exiting ? 'translateY(0) scale(1)' : 'translateY(-12px) scale(0.95)',
                opacity: visible && !exiting ? 1 : 0,
                transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 14,
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 260,
                maxWidth: 380,
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: colors.glow,
                pointerEvents: 'auto',
            }}
        >
            <span style={{
                fontSize: 16,
                flexShrink: 0,
                animation: item.type === 'loading' ? 'spin 1s linear infinite' : undefined,
                filter: 'brightness(1.3)',
            }}>
                {ICONS[item.type]}
            </span>
            <span style={{
                flex: 1,
                color: '#ffffff',
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.3,
                letterSpacing: '0.01em',
            }}>
                {item.message}
            </span>
            {item.action && (
                <button
                    onClick={() => {
                        item.action!.onClick();
                        setExiting(true);
                        setTimeout(onClose, 300);
                    }}
                    style={{
                        background: 'rgba(255,255,255,0.15)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: 8,
                        padding: '4px 10px',
                        color: '#ffffff',
                        fontFamily: "'Inter', sans-serif",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.25)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
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
            setToasts(prev => [...prev.slice(-4), item]); // Keep max 5
        };
        listeners.add(handler);
        return () => { listeners.delete(handler); };
    }, []);

    const removeToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
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
            {toasts.map(t => (
                <SingleToast key={t.id} item={t} onClose={() => removeToast(t.id)} />
            ))}
        </div>
    );
};

// ── Legacy useToast hook (backwards-compatible) ────────────────────
export const useToast = () => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const showToast = (message: string, type: ToastType = 'info', duration?: number) => {
        const id = nextId++;
        setToasts(prev => [...prev, { id, message, type, duration: duration ?? 3000 }]);
        // Also emit globally
        emit(message, type, duration ?? 3000);
        return id;
    };

    const hideToast = (id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
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
