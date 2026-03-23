/**
 * UIContext — Bridge layer (delegates to Zustand uiStore).
 *
 * Keeps the Provider + useUI() API so existing consumers work.
 * New code should import from `stores/uiStore` directly.
 */

import React from 'react';
import { useUIStore } from '../stores/uiStore';

/** @deprecated Use `useUIStore()` directly */
export const useUI = () => {
    return useUIStore();
};

/** No-op provider — store is global */
export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return React.createElement(React.Fragment, null, children);
};
