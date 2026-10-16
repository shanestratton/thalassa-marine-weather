import { useSyncExternalStore } from 'react';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { defaultWakeRules, validWakeRule, WAKE_PRESETS, type WakeRule } from '../../utils/wakeRule';

const KEY = 'thalassa_wake_rules_v1';
const MAX_BYTES = 32_768;
const listeners = new Set<() => void>();
export interface WakeRulePreferences {
    readonly scope: AuthIdentityScope;
    readonly rules: readonly WakeRule[];
    readonly unreadable: boolean;
    readonly saved: boolean;
}
/** Disabled drafts may lack a sensor or redline; an enabled rule must be complete. */
export function validWakeDraft(rule: WakeRule): boolean {
    if (!rule || !Object.hasOwn(WAKE_PRESETS, rule.preset)) return false;
    if (rule.enabled) return validWakeRule(rule);
    const spec = WAKE_PRESETS[rule.preset];
    return (
        rule.enabled === false &&
        validWakeRule({
            ...rule,
            selection: rule.selection ?? {
                feedId: 'disabled-draft',
                sensorId: 'disabled-draft',
                reference: spec.reference,
                ...(rule.preset.startsWith('engine-') || rule.preset === 'battery-below'
                    ? { instance: 'unselected' }
                    : {}),
            },
            threshold: rule.threshold === null ? spec.thresholdMin : rule.threshold,
        })
    );
}
export function copyWakeRule(rule: WakeRule): WakeRule {
    return {
        preset: rule.preset,
        enabled: rule.enabled,
        selection: rule.selection
            ? {
                  feedId: rule.selection.feedId,
                  sensorId: rule.selection.sensorId,
                  reference: rule.selection.reference,
                  ...(rule.selection.instance === undefined ? {} : { instance: rule.selection.instance }),
              }
            : null,
        threshold: rule.threshold,
        hysteresis: rule.hysteresis,
        minimumDurationMs: rule.minimumDurationMs,
        clearDurationMs: rule.clearDurationMs,
        quietHours: rule.quietHours
            ? {
                  startMinute: rule.quietHours.startMinute,
                  endMinute: rule.quietHours.endMinute,
                  utcOffsetMinutes: rule.quietHours.utcOffsetMinutes,
              }
            : null,
    };
}
function validSet(raw: unknown): raw is WakeRule[] {
    return (
        Array.isArray(raw) &&
        raw.length === Object.keys(WAKE_PRESETS).length &&
        new Set(raw.map((rule) => rule?.preset)).size === raw.length &&
        raw.every(validWakeDraft)
    );
}
function snapshot(
    scope: AuthIdentityScope,
    rules: readonly WakeRule[],
    unreadable: boolean,
    saved: boolean,
): WakeRulePreferences {
    const safe = defaultWakeRules().map(({ preset }) => copyWakeRule(rules.find((rule) => rule.preset === preset)!));
    for (const rule of safe) {
        if (rule.selection) Object.freeze(rule.selection);
        if (rule.quietHours) Object.freeze(rule.quietHours);
        Object.freeze(rule);
    }
    return Object.freeze({ scope, rules: Object.freeze(safe), unreadable, saved });
}
function read(previous?: WakeRulePreferences, retry = false): WakeRulePreferences {
    const scope = getAuthIdentityScope();
    const sameOwner = previous?.scope.key === scope.key && previous.scope.generation === scope.generation;
    const retained = () =>
        snapshot(scope, sameOwner ? previous.rules : defaultWakeRules(), true, sameOwner ? previous.saved : false);
    let next: WakeRulePreferences;
    try {
        const bytes = localStorage.getItem(authScopedStorageKey(KEY, scope));
        if (bytes === null)
            next = sameOwner && previous.saved ? retained() : snapshot(scope, defaultWakeRules(), false, false);
        else {
            if (new TextEncoder().encode(bytes).length > MAX_BYTES) throw Error();
            const parsed = JSON.parse(bytes);
            if (parsed?.schema !== 1 || parsed.owner !== scope.key || !validSet(parsed.rules)) throw Error();
            next = snapshot(scope, parsed.rules, false, true);
        }
    } catch {
        next = retained();
    }
    if (!isAuthIdentityScopeCurrent(scope))
        return retry ? snapshot(getAuthIdentityScope(), defaultWakeRules(), true, false) : read(undefined, true);
    return next;
}
let value = read();
const emit = () => {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            console.error('[WakeRulePreferences] subscriber failed');
        }
    }
};
subscribeAuthIdentityScope(() => {
    value = read();
    emit();
});
if (typeof window !== 'undefined')
    window.addEventListener('storage', (event) => {
        if (event.storageArea && event.storageArea !== localStorage) return;
        if (event.key === authScopedStorageKey(KEY) || event.key === null) {
            value = read(value);
            emit();
        }
    });
export const getWakeRulePreferences = () => value;
export function subscribeWakeRulePreferences(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function saveWakeRulePreferences(rules: readonly WakeRule[], scope: AuthIdentityScope): boolean {
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    try {
        if (!validSet(rules)) return false;
        const safe = snapshot(scope, rules, false, true);
        const bytes = JSON.stringify({ schema: 1, owner: scope.key, rules: safe.rules });
        if (new TextEncoder().encode(bytes).length > MAX_BYTES || !isAuthIdentityScopeCurrent(scope)) return false;
        const key = authScopedStorageKey(KEY, scope);
        localStorage.setItem(key, bytes);
        if (
            !isAuthIdentityScopeCurrent(scope) ||
            localStorage.getItem(key) !== bytes ||
            !isAuthIdentityScopeCurrent(scope)
        )
            return false;
        value = safe;
        emit();
        return true;
    } catch {
        return false;
    }
}
export function useWakeRulePreferences() {
    return useSyncExternalStore(subscribeWakeRulePreferences, getWakeRulePreferences, getWakeRulePreferences);
}
