/**
 * PushToast — Foreground push notification toast component.
 *
 * iOS suppresses notification banners when the app is in the foreground.
 * This component displays an in-app toast that slides down from the top,
 * with type-specific styling and tap-to-navigate functionality.
 *
 * Features:
 * - Auto-dismiss after 5 seconds (critical alerts stay for 8 seconds)
 * - Swipe up to dismiss
 * - Tap to navigate to relevant page
 * - Type-specific icons and colors
 * - Stacks up to 3 toasts
 * - Haptic feedback on show
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { triggerHaptic } from '../utils/system';

interface ToastItem {
    id: string;
    title: string;
    body: string;
    type: string;
    data?: Record<string, unknown>;
    createdAt: number;
    dismissing?: boolean;
}

interface PushToastProps {
    onTap?: (data: Record<string, unknown>) => void;
}

const MAX_TOASTS = 3;
const DISMISS_MS = 5000;
const CRITICAL_DISMISS_MS = 8000;

const CRITICAL_TYPES = ['anchor_alarm', 'bolo_alert', 'suspicious_alert', 'drag_warning', 'geofence_alert'];

function getToastStyle(type: string) {
    switch (type) {
        case 'bolo_alert':
            return { icon: '🚨', gradient: 'from-red-600/95 to-red-700/95', border: 'border-red-400/30' };
        case 'suspicious_alert':
            return { icon: '⚠️', gradient: 'from-amber-600/95 to-amber-700/95', border: 'border-amber-400/30' };
        case 'anchor_alarm':
            return { icon: '⚓', gradient: 'from-orange-600/95 to-orange-700/95', border: 'border-orange-400/30' };
        case 'drag_warning':
            return { icon: '⚓', gradient: 'from-orange-500/95 to-red-600/95', border: 'border-orange-400/30' };
        case 'geofence_alert':
            return { icon: '🏠', gradient: 'from-purple-600/95 to-purple-700/95', border: 'border-purple-400/30' };
        case 'weather_alert':
            return { icon: '⛈️', gradient: 'from-sky-600/95 to-sky-700/95', border: 'border-sky-400/30' };
        case 'hail':
            return { icon: '🏴‍☠️', gradient: 'from-emerald-600/95 to-emerald-700/95', border: 'border-emerald-400/30' };
        case 'dm':
            return { icon: '💬', gradient: 'from-blue-600/95 to-blue-700/95', border: 'border-blue-400/30' };
        default:
            return { icon: '📡', gradient: 'from-slate-700/95 to-slate-800/95', border: 'border-white/10' };
    }
}

// ── Singleton toast queue (accessible from PushNotificationService) ──
type ToastPusher = (notification: { title?: string; body?: string; data?: Record<string, unknown> }) => void;
let globalPushToast: ToastPusher | null = null;

export function pushForegroundToast(notification: { title?: string; body?: string; data?: Record<string, unknown> }) {
    if (globalPushToast) globalPushToast(notification);
}

export const PushToast: React.FC<PushToastProps> = ({ onTap }) => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const touchStartY = useRef(0);

    // Register the global push function
    const addToast = useCallback((notification: { title?: string; body?: string; data?: Record<string, unknown> }) => {
        const type = (notification.data?.notification_type as string) || 'general';
        const isCritical = CRITICAL_TYPES.includes(type);

        const toast: ToastItem = {
            id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: notification.title || 'Thalassa',
            body: notification.body || '',
            type,
            data: notification.data,
            createdAt: Date.now(),
        };

        // Haptic
        triggerHaptic(isCritical ? 'heavy' : 'medium');

        setToasts((prev) => {
            const next = [toast, ...prev];
            // Cap at MAX_TOASTS
            return next.slice(0, MAX_TOASTS);
        });

        // Auto-dismiss
        const timeout = isCritical ? CRITICAL_DISMISS_MS : DISMISS_MS;
        setTimeout(() => {
            setToasts((prev) => prev.map((t) => (t.id === toast.id ? { ...t, dismissing: true } : t)));
            setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== toast.id));
            }, 300); // Allow exit animation
        }, timeout);
    }, []);

    useEffect(() => {
        globalPushToast = addToast;
        return () => {
            globalPushToast = null;
        };
    }, [addToast]);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, dismissing: true } : t)));
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 300);
    }, []);

    const handleTap = useCallback(
        (toast: ToastItem) => {
            dismiss(toast.id);
            if (onTap && toast.data) onTap(toast.data);
        },
        [dismiss, onTap],
    );

    if (toasts.length === 0) return null;

    return (
        <div
            className="fixed top-0 left-0 right-0 z-[9999] pointer-events-none"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px)' }}
        >
            <div className="flex flex-col items-center gap-2 px-4">
                {toasts.map((toast, index) => {
                    const style = getToastStyle(toast.type);
                    const isCritical = CRITICAL_TYPES.includes(toast.type);

                    return (
                        <div
                            key={toast.id}
                            className={`
                                w-full max-w-md pointer-events-auto cursor-pointer
                                bg-gradient-to-r ${style.gradient} ${style.border}
                                border backdrop-blur-xl rounded-2xl
                                shadow-2xl shadow-black/40
                                transition-all duration-300 ease-out
                                ${
                                    toast.dismissing
                                        ? 'opacity-0 -translate-y-4 scale-95'
                                        : 'opacity-100 translate-y-0 scale-100'
                                }
                                ${isCritical ? 'animate-pulse' : ''}
                            `}
                            style={{
                                animationDuration: isCritical ? '2s' : undefined,
                                transform: `scale(${1 - index * 0.03})`,
                            }}
                            onClick={() => handleTap(toast)}
                            onTouchStart={(e) => {
                                touchStartY.current = e.touches[0].clientY;
                            }}
                            onTouchEnd={(e) => {
                                const dy = e.changedTouches[0].clientY - touchStartY.current;
                                if (dy < -30) dismiss(toast.id); // Swipe up
                            }}
                        >
                            <div className="flex items-start gap-3 p-3.5">
                                <span className="text-xl shrink-0 mt-0.5">{style.icon}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[11px] font-black text-white/90 uppercase tracking-wider truncate">
                                        {toast.title}
                                    </div>
                                    <div className="text-xs text-white/80 mt-0.5 line-clamp-2 font-medium">
                                        {toast.body}
                                    </div>
                                </div>
                                {isCritical && (
                                    <div className="w-2 h-2 rounded-full bg-red-400 animate-ping shrink-0 mt-1" />
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
