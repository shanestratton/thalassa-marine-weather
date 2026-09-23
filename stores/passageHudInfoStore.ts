/**
 * The existing blue ℹ panel owns the passage forecast's explanations and
 * attribution. This is an in-memory view descriptor, never a persisted fix,
 * forecast or route. The scrubber clears it when that forecast view ends.
 */
import { useSyncExternalStore } from 'react';

export interface PassageHudInfo {
    moment: string;
    modelLabel: string;
    note: string | null;
    ownTime: readonly string[];
    joining: boolean;
    credited: readonly string[];
    windCoverageHours: number | null;
    rainCoverageHours: number | null;
}

let info: PassageHudInfo | null = null;
let squallVisible = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
const notify = () => listeners.forEach((listener) => listener());

export const getPassageHudInfo = (): PassageHudInfo | null => info;
export function publishPassageHudInfo(next: PassageHudInfo | null): void {
    if (info === next) return;
    info = next;
    notify();
}
export function usePassageHudInfo(): PassageHudInfo | null {
    return useSyncExternalStore(subscribe, getPassageHudInfo, getPassageHudInfo);
}

export const getPassageSquallInfoVisible = (): boolean => squallVisible;
export function setPassageSquallInfoVisible(next: boolean): void {
    if (next === squallVisible) return;
    squallVisible = next;
    notify();
}
export function usePassageSquallInfoVisible(): boolean {
    return useSyncExternalStore(subscribe, getPassageSquallInfoVisible, getPassageSquallInfoVisible);
}
