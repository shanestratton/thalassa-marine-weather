/**
 * FollowRouteContext — Bridge layer (delegates to Zustand followRouteStore).
 *
 * Keeps the Provider + useFollowRoute() API so existing consumers work.
 * New code should import from `stores/followRouteStore` directly.
 */

import React from 'react';
import { useFollowRouteStore } from '../stores/followRouteStore';
import type { FollowRouteState } from '../stores/followRouteStore';

export type { FollowRouteState };

/** @deprecated Use `useFollowRouteStore()` directly */
export const useFollowRoute = () => {
    return useFollowRouteStore();
};

/** No-op provider — store is global */
export const FollowRouteProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return React.createElement(React.Fragment, null, children);
};
