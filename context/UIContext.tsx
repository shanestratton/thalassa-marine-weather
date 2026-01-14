
import React, { createContext, useContext, useState, useEffect } from 'react';

// type ViewType = 'dashboard' | 'voyage' | 'map' | 'settings';

interface UIContextType {
    currentView: string;
    setPage: (page: string) => void;
    isOffline: boolean;
    debugLogs: string[];
    addDebugLog: (msg: string) => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [currentView, setCurrentView] = useState<string>('dashboard');
    const [isOffline, setIsOffline] = useState(!navigator.onLine);
    const [debugLogs, setDebugLogs] = useState<string[]>([]);

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

    const addDebugLog = (msg: string) => {
        setDebugLogs(prev => [`[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`, ...prev].slice(0, 20));
    };

    return (
        <UIContext.Provider value={{
            currentView,
            setPage: setCurrentView,
            isOffline,
            debugLogs,
            addDebugLog
        }}>
            {children}
        </UIContext.Provider>
    );
};

export const useUI = () => {
    const context = useContext(UIContext);
    if (context === undefined) {
        throw new Error('useUI must be used within an UIProvider');
    }
    return context;
};
