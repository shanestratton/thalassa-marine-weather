/**
 * NetworkModeContext — Bridge layer (delegates to Zustand networkModeStore).
 *
 * Keeps the Provider + useNetworkMode() API so existing consumers work.
 * New code should import from `stores/networkModeStore` directly.
 */

import React from 'react';
import { useNetworkModeStore } from '../stores/networkModeStore';

export type { NetworkMode } from '../stores/networkModeStore';

/** @deprecated Use `useNetworkModeStore()` directly */
export function useNetworkMode() {
    return useNetworkModeStore();
}

/** No-op provider — store is global, no React tree needed */
export const NetworkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return React.createElement(React.Fragment, null, children);
};
