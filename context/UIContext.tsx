import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { TransitionDirection } from '../components/ui/PageTransition';

// Main tab pages (bottom nav) — switching between these = "tab" transition
const TAB_PAGES = new Set(['dashboard', 'map', 'chat', 'vessel']);

// Pages that are children of vessel (push/pop within the vessel hub)
const VESSEL_CHILDREN = new Set([
    'details',
    'compass',
    'inventory',
    'maintenance',
    'polars',
    'nmea',
    'equipment',
    'documents',
    'diary',
    'route',
]);

// Overlay pages (push from any tab, pop back)
const OVERLAY_PAGES = new Set(['settings', 'warnings', 'voyage']);

interface UIContextType {
    currentView: string;
    previousView: string;
    transitionDirection: TransitionDirection;
    setPage: (page: string) => void;
    isOffline: boolean;
    debugLogs: string[];
    addDebugLog: (msg: string) => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [currentView, setCurrentView] = useState<string>('dashboard');
    const [previousView, setPreviousView] = useState<string>('dashboard');
    const [transitionDirection, setTransitionDirection] = useState<TransitionDirection>('tab');
    const [isOffline, setIsOffline] = useState(!navigator.onLine);
    const [debugLogs, setDebugLogs] = useState<string[]>([]);
    const prevRef = useRef(currentView);

    useEffect(() => {
        const handleOnline = () => setIsOffline(false);
        const handleOffline = () => setIsOffline(true);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const setPage = useCallback((page: string) => {
        const prev = prevRef.current;
        setPreviousView(prev);
        prevRef.current = page;

        // Determine transition type:
        // 1. Tab switch (both are main tab pages) → instant swap
        // 2. Push (going deeper: tab → child, tab → overlay, child → child)
        // 3. Pop (going back: child → tab, overlay → tab)
        if (TAB_PAGES.has(page) && TAB_PAGES.has(prev)) {
            setTransitionDirection('tab');
        } else if (OVERLAY_PAGES.has(page)) {
            // Opening settings/warnings/voyage = push
            setTransitionDirection('push');
        } else if (TAB_PAGES.has(page) && (VESSEL_CHILDREN.has(prev) || OVERLAY_PAGES.has(prev))) {
            // Going back to a tab from a child or overlay = pop
            setTransitionDirection('pop');
        } else if (VESSEL_CHILDREN.has(page) && TAB_PAGES.has(prev)) {
            // Going from a tab to a child page = push
            setTransitionDirection('push');
        } else if (VESSEL_CHILDREN.has(page) && VESSEL_CHILDREN.has(prev)) {
            // Sibling navigation within vessel
            setTransitionDirection('push');
        } else {
            // Fallback — instant swap (safe default)
            setTransitionDirection('tab');
        }

        setCurrentView(page);
    }, []);

    const addDebugLog = useCallback((msg: string) => {
        setDebugLogs((prev) => [`[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`, ...prev].slice(0, 20));
    }, []);

    const contextValue = useMemo(
        () => ({
            currentView,
            previousView,
            transitionDirection,
            setPage,
            isOffline,
            debugLogs,
            addDebugLog,
        }),
        [currentView, previousView, transitionDirection, setPage, isOffline, debugLogs, addDebugLog],
    );

    return <UIContext.Provider value={contextValue}>{children}</UIContext.Provider>;
};

export const useUI = () => {
    const context = useContext(UIContext);
    if (context === undefined) {
        throw new Error('useUI must be used within an UIProvider');
    }
    return context;
};
