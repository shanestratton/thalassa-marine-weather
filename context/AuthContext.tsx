/**
 * AuthContext — Bridge layer (delegates to Zustand authStore).
 *
 * Keeps the Provider + useAuth() API so existing consumers work.
 * New code should import from `stores/authStore` directly.
 */

import React from 'react';
import { useAuthStore } from '../stores/authStore';

/** @deprecated Use `useAuthStore()` directly */
export const useAuth = () => {
    return useAuthStore();
};

/** No-op provider — store self-initializes at module load */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return React.createElement(React.Fragment, null, children);
};
