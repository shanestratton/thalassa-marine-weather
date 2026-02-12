
import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { PushNotificationService } from '../services/PushNotificationService';

interface AuthContextType {
    user: User | null;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);

    useEffect(() => {
        if (!supabase) return;

        // Initialize push notification listeners (once, early)
        PushNotificationService.initialize();

        // Check active session
        supabase.auth.getSession().then(({ data: { session } }) => {
            const u = session?.user ?? null;
            setUser(u);
            if (u) {
                // User already logged in — register push token
                PushNotificationService.setUser(u.id);
                PushNotificationService.requestPermissionAndRegister();
            }
        });

        // Listen for auth changes (login/logout)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            const u = session?.user ?? null;
            setUser(u);
            if (u) {
                PushNotificationService.setUser(u.id);
                PushNotificationService.requestPermissionAndRegister();
            } else {
                PushNotificationService.clearUser();
            }
        });

        return () => subscription.unsubscribe();
    }, []);

    const logout = async () => {
        if (!supabase) return;
        await PushNotificationService.clearUser();
        await supabase.auth.signOut();
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
