
import React, { createContext, useContext, useState, useEffect } from 'react';

type ViewType = 'dashboard' | 'voyage' | 'map' | 'settings';

interface UIContextType {
    currentView: ViewType;
    setPage: (view: ViewType) => void;
    isOffline: boolean;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [view, setView] = useState<ViewType>('dashboard');
    const [isOffline, setIsOffline] = useState(!navigator.onLine);

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

    return (
        <UIContext.Provider value={{
            currentView: view,
            setPage: setView,
            isOffline
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
