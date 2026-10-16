/** Explicitly loaded reports only. No startup action, disk, fetch or export. */
import { useSyncExternalStore } from 'react';
import { subscribeAuthIdentityScope } from '../services/authIdentityScope';
import { subscribe as subscribeCharts } from '../services/enc/EncCellMetadata';
import { useSettingsStore } from './settingsStore';
import { WindStore } from './WindStore';
import type { AlongRouteReport } from '../services/routing/alongRouteReportTypes';

let report: AlongRouteReport | null = null;
let valid: (() => boolean) | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export function clearAlongRouteReport(): void {
    if (!report) return;
    report = null;
    valid = null;
    notify();
}
const changed = () => {
    if (report && !valid?.()) clearAlongRouteReport();
};
subscribeAuthIdentityScope(clearAlongRouteReport);
subscribeCharts(changed);
useSettingsStore.subscribe(changed);
WindStore.subscribe(changed);

export function publishAlongRouteReport(next: AlongRouteReport, isCurrent: () => boolean): void {
    if (!isCurrent()) return;
    report = next;
    valid = isCurrent;
    notify();
}
export const getAlongRouteReport = (): AlongRouteReport | null => (report && valid?.() ? report : null);
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export const useAlongRouteReport = () => useSyncExternalStore(subscribe, getAlongRouteReport, getAlongRouteReport);

/** Unknown/repeated visits never acquire a next-up ETA. HUD callers must
 * supply a fresh, qualified route progress or explicit look-ahead distance. */
export function nextAlongRouteRow(report: AlongRouteReport, alongNm: number | null) {
    if (alongNm === null || !Number.isFinite(alongNm) || alongNm < 0 || alongNm > report.totalNm) return null;
    return report.rows.find((row) => !row.ambiguousVisit && row.alongNm >= alongNm) ?? null;
}
