/**
 * Pure helpers + external-store adapters for LogPage — extracted verbatim from
 * pages/LogPage.tsx. No React, no component state.
 */

import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import type { ShipLogEntry } from '../../types';
import { FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS, SYSTEM_LOG_ENDPOINT_NAMES } from './logPageTypes';

/** A human-entered waypoint wins; recorder placeholders do not name a place. */
export function meaningfulLogEndpointName(entry: Pick<ShipLogEntry, 'waypointName'> | undefined): string | null {
    const name = entry?.waypointName?.trim();
    return name && !SYSTEM_LOG_ENDPOINT_NAMES.has(name) ? name : null;
}

/** Do not trap the cast-off sheet behind an unbounded marine-data request.
 *  Late fulfilments are consumed but ignored, so they cannot resurrect a
 *  selection after the UI has unlocked. */
export function withFollowRouteLoadDeadline<T>(promise: Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            settled = true;
            resolve(null);
        }, FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export const subscribeIdentitySnapshot = (notify: () => void): (() => void) =>
    subscribeAuthIdentityScope(() => notify());
export const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();
