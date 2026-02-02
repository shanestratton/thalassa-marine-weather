/**
 * Toast Notification Component
 * Shows temporary success/error/loading messages
 */

import React, { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'loading' | 'info';

interface ToastProps {
    message: string;
    type: ToastType;
    onClose?: () => void;
    duration?: number; // Auto-close after ms (0 = manual close only)
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose, duration = 3000 }) => {
    const [isVisible, setIsVisible] = useState(true);

    useEffect(() => {
        if (duration > 0) {
            const timer = setTimeout(() => {
                setIsVisible(false);
                setTimeout(() => onClose?.(), 300);
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [duration, onClose]);

    const typeStyles = {
        success: 'bg-emerald-500 border-emerald-400',
        error: 'bg-red-500 border-red-400',
        loading: 'bg-blue-500 border-blue-400',
        info: 'bg-slate-600 border-slate-500'
    };

    const icons = {
        success: '✓',
        error: '✕',
        loading: '⟳',
        info: 'ℹ'
    };

    return (
        <div
            className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
                }`}
        >
            <div className={`${typeStyles[type]} border-2 rounded-lg shadow-2xl px-6 py-3 flex items-center gap-3 min-w-[300px] max-w-[500px]`}>
                <div className={`text-2xl ${type === 'loading' ? 'animate-spin' : ''}`}>
                    {icons[type]}
                </div>
                <div className="text-white font-bold flex-1">{message}</div>
                {duration === 0 && (
                    <button
                        onClick={() => {
                            setIsVisible(false);
                            setTimeout(() => onClose?.(), 300);
                        }}
                        className="text-white/80 hover:text-white text-xl font-bold"
                    >
                        ×
                    </button>
                )}
            </div>
        </div>
    );
};

/**
 * Toast Manager Hook
 */
interface ToastData {
    id: number;
    message: string;
    type: ToastType;
    duration?: number;
}

export const useToast = () => {
    const [toasts, setToasts] = useState<ToastData[]>([]);
    let nextId = 0;

    const showToast = (message: string, type: ToastType = 'info', duration?: number) => {
        const id = nextId++;
        setToasts(prev => [...prev, { id, message, type, duration }]);
        return id;
    };

    const hideToast = (id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    };

    const ToastContainer = () => (
        <>
            {toasts.map(toast => (
                <Toast
                    key={toast.id}
                    message={toast.message}
                    type={toast.type}
                    duration={toast.duration}
                    onClose={() => hideToast(toast.id)}
                />
            ))}
        </>
    );

    return {
        showToast,
        hideToast,
        ToastContainer,
        success: (msg: string, duration?: number) => showToast(msg, 'success', duration),
        error: (msg: string, duration?: number) => showToast(msg, 'error', duration),
        loading: (msg: string) => showToast(msg, 'loading', 0), // Loading never auto-closes
        info: (msg: string, duration?: number) => showToast(msg, 'info', duration)
    };
};
