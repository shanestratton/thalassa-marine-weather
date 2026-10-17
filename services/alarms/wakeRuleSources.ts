import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { validWakeSelection, WAKE_PRESETS, type WakePreset, type WakeSelection } from '../../utils/wakeRule';

/** Controller-owned evidence, never saved settings or arbitrary paths.
 * The controller must clear this catalogue on pairing/vessel retirement. */
export interface WakeSourceOption {
    preset: WakePreset;
    selection: WakeSelection;
    label: string;
    /** Original qualifying leaf/dependency minimum, never HTTP receipt time. */
    measuredAt: number;
}
interface WakeSources {
    scope: AuthIdentityScope;
    options: readonly WakeSourceOption[];
}
const listeners = new Set<() => void>();
const empty = (): WakeSources => Object.freeze({ scope: getAuthIdentityScope(), options: Object.freeze([]) });
let value = empty();
const notify = () => {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            console.error('[WakeRuleSources] subscriber failed');
        }
    }
};
subscribeAuthIdentityScope(() => {
    value = empty();
    notify();
});
export const wakeSourceKey = (preset: WakePreset, selection: WakeSelection) =>
    JSON.stringify([preset, selection.feedId, selection.sensorId, selection.reference, selection.instance]);
export function publishWakeRuleSources(scope: AuthIdentityScope, options: readonly WakeSourceOption[]): boolean {
    if (!isAuthIdentityScopeCurrent(scope) || !Array.isArray(options) || options.length > 32) return false;
    const seen = new Set<string>();
    for (const option of options) {
        if (
            !option ||
            !Object.hasOwn(WAKE_PRESETS, option.preset) ||
            !validWakeSelection(option.preset, option.selection) ||
            typeof option.label !== 'string' ||
            !option.label.trim() ||
            option.label.length > 80 ||
            !Number.isSafeInteger(option.measuredAt) ||
            option.measuredAt <= 0
        )
            return false;
        const key = wakeSourceKey(option.preset, option.selection);
        if (seen.has(key)) return false;
        seen.add(key);
    }
    const next = Object.freeze({
        scope,
        options: Object.freeze(
            options.map((option) =>
                Object.freeze({
                    preset: option.preset,
                    selection: Object.freeze({
                        feedId: option.selection.feedId,
                        sensorId: option.selection.sensorId,
                        reference: option.selection.reference,
                        ...(option.selection.instance === undefined ? {} : { instance: option.selection.instance }),
                    }),
                    label: option.label,
                    measuredAt: option.measuredAt,
                }),
            ),
        ),
    });
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    value = next;
    notify();
    return true;
}
export const clearWakeRuleSources = (scope: AuthIdentityScope) => publishWakeRuleSources(scope, []);
export const getWakeRuleSources = () => value;
export function subscribeWakeRuleSources(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function currentWakeRuleSources(snapshot: WakeSources, now: number): readonly WakeSourceOption[] {
    if (!isAuthIdentityScopeCurrent(snapshot.scope) || !Number.isFinite(now)) return [];
    return snapshot.options.filter(
        (option) => option.measuredAt <= now + 1000 && now - option.measuredAt <= WAKE_PRESETS[option.preset].maxAge,
    );
}
export function useWakeRuleSources(): readonly WakeSourceOption[] {
    const snapshot = useSyncExternalStore(subscribeWakeRuleSources, getWakeRuleSources, getWakeRuleSources);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    return currentWakeRuleSources(snapshot, now);
}
