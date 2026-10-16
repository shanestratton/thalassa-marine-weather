import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    copyWakeRule,
    getWakeRulePreferences,
    saveWakeRulePreferences,
    subscribeWakeRulePreferences,
    validWakeDraft,
} from '../services/alarms/wakeRulePreferences';
import {
    currentWakeRuleSources,
    getWakeRuleSources,
    publishWakeRuleSources,
    type WakeSourceOption,
} from '../services/alarms/wakeRuleSources';
import { defaultWakeRules, type WakeRule } from '../utils/wakeRule';
const KEY = 'thalassa_wake_rules_v1';
let index = 0;
beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    setAuthIdentityScope('generated-wake-owner-' + ++index);
});
afterEach(() => vi.restoreAllMocks());
const enabled = (): WakeRule[] =>
    defaultWakeRules().map((rule) =>
        rule.preset === 'wind-above'
            ? {
                  ...rule,
                  enabled: true,
                  selection: { feedId: 'pi:fictional:verified-vessel', sensorId: 'n2k.17', reference: 'true-water' },
              }
            : rule,
    );
const changed = () =>
    window.dispatchEvent(new StorageEvent('storage', { key: authScopedStorageKey(KEY), storageArea: localStorage }));

describe('account-scoped wake settings', () => {
    it('stores eight canonical disabled drafts, with no invented sensor or equipment redline', () => {
        expect(defaultWakeRules().every(validWakeDraft)).toBe(true);
        expect(saveWakeRulePreferences(defaultWakeRules().reverse(), getAuthIdentityScope())).toBe(true);
        const stored = JSON.parse(localStorage.getItem(authScopedStorageKey(KEY))!);
        expect(stored.owner).toBe(getAuthIdentityScope().key);
        expect(stored.rules.map((rule: WakeRule) => rule.preset)).toEqual(
            defaultWakeRules().map((rule) => rule.preset),
        );
        expect(stored.rules.every((rule: WakeRule) => !rule.enabled && rule.selection === null)).toBe(true);
    });
    it('refuses incomplete enabled rules, duplicate/unknown/extra presets and malformed timing', () => {
        const mutations = [
            (rules: WakeRule[]) => {
                rules[0].enabled = true;
            },
            (rules: WakeRule[]) => {
                rules[1] = rules[0];
            },
            (rules: WakeRule[]) => {
                rules[0].preset = 'some.path' as WakeRule['preset'];
            },
            (rules: WakeRule[]) => {
                rules.push(rules[0]);
            },
            (rules: WakeRule[]) => {
                rules[0].hysteresis = NaN;
            },
            (rules: WakeRule[]) => {
                rules[0].minimumDurationMs = -1;
            },
            (rules: WakeRule[]) => {
                rules[0].quietHours = { startMinute: 0, endMinute: 0, utcOffsetMinutes: 0 };
            },
        ];
        for (const mutate of mutations) {
            const rules = defaultWakeRules();
            mutate(rules);
            expect(saveWakeRulePreferences(rules, getAuthIdentityScope())).toBe(false);
        }
        expect(saveWakeRulePreferences(enabled(), getAuthIdentityScope())).toBe(true);
    });
    it('retains last valid same-owner alarms on corrupt, oversized, foreign-owner or missing storage', () => {
        const scope = getAuthIdentityScope();
        saveWakeRulePreferences(enabled(), scope);
        const expected = getWakeRulePreferences().rules;
        for (const raw of [
            '{',
            'x'.repeat(32_769),
            JSON.stringify({ schema: 1, owner: 'user:other', rules: defaultWakeRules() }),
            '',
        ]) {
            localStorage.setItem(authScopedStorageKey(KEY), raw);
            changed();
            expect(getWakeRulePreferences().rules).toEqual(expected);
            expect(getWakeRulePreferences().unreadable).toBe(true);
        }
        localStorage.removeItem(authScopedStorageKey(KEY));
        changed();
        expect(getWakeRulePreferences().rules).toEqual(expected);
        expect(getWakeRulePreferences().unreadable).toBe(true);
        expect(saveWakeRulePreferences(expected, scope)).toBe(true);
        expect(getWakeRulePreferences().unreadable).toBe(false);
    });
    it('never exposes another account or accepts its copied settings', () => {
        const first = getAuthIdentityScope();
        saveWakeRulePreferences(enabled(), first);
        const raw = localStorage.getItem(authScopedStorageKey(KEY))!;
        setAuthIdentityScope('generated-second-owner');
        localStorage.setItem(authScopedStorageKey(KEY), raw);
        changed();
        expect(getWakeRulePreferences().rules.every((rule) => !rule.enabled)).toBe(true);
        expect(saveWakeRulePreferences(enabled(), first)).toBe(false);
        setAuthIdentityScope(first.userId);
        expect(getWakeRulePreferences().rules).toEqual(enabled());
    });
    it('rejects writes and reads retired by an identity switch', () => {
        const first = getAuthIdentityScope(),
            write = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, raw) {
            write.call(this, key, raw);
            if (key === authScopedStorageKey(KEY, first)) setAuthIdentityScope('generated-write-swap');
        });
        expect(saveWakeRulePreferences(enabled(), first)).toBe(false);
        expect(getWakeRulePreferences().scope.key).toBe('user:generated-write-swap');
        expect(getWakeRulePreferences().rules.every((rule) => !rule.enabled)).toBe(true);
        vi.restoreAllMocks();
        setAuthIdentityScope(first.userId);
        const read = Storage.prototype.getItem;
        let swapped = false;
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
            const raw = read.call(this, key);
            if (!swapped && key === authScopedStorageKey(KEY, getWakeRulePreferences().scope)) {
                swapped = true;
                setAuthIdentityScope('generated-read-swap');
            }
            return raw;
        });
        changed();
        expect(getWakeRulePreferences().scope.key).toBe('user:generated-read-swap');
        expect(getWakeRulePreferences().rules.every((rule) => !rule.enabled)).toBe(true);
    });
    it('reports quota failure and does not let a bad view subscriber block the controller', () => {
        const scope = getAuthIdentityScope(),
            initial = getWakeRulePreferences();
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw Error('quota');
        });
        expect(saveWakeRulePreferences(enabled(), scope)).toBe(false);
        expect(getWakeRulePreferences()).toBe(initial);
        vi.restoreAllMocks();
        const good = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const badOff = subscribeWakeRulePreferences(() => {
                throw Error('bad view');
            }),
            goodOff = subscribeWakeRulePreferences(good);
        expect(saveWakeRulePreferences(enabled(), scope)).toBe(true);
        expect(good).toHaveBeenCalledTimes(1);
        badOff();
        goodOff();
    });
    it('copies and freezes only the supported fields, excluding hidden paths', () => {
        const rules = enabled();
        Object.assign(rules[1].selection!, { path: 'some.command' });
        expect(saveWakeRulePreferences(rules, getAuthIdentityScope())).toBe(true);
        rules[1].threshold = 100;
        expect(getWakeRulePreferences().rules[1].threshold).toBe(25);
        expect(localStorage.getItem(authScopedStorageKey(KEY))).not.toContain('some.command');
        expect(Object.isFrozen(getWakeRulePreferences().rules[1].selection)).toBe(true);
        expect(copyWakeRule(getWakeRulePreferences().rules[1])).toEqual(enabled()[1]);
    });
});

describe('qualified source choices', () => {
    const option = (): WakeSourceOption => ({
        preset: 'wind-above',
        selection: { feedId: 'pi:fictional:verified-vessel', sensorId: 'n2k.17', reference: 'true-water' },
        label: 'Mast true wind',
        measuredAt: Date.now(),
    });
    it('ages from original measurement time, not catalogue receipt/republication', () => {
        const source = option(),
            scope = getAuthIdentityScope();
        expect(publishWakeRuleSources(scope, [source])).toBe(true);
        expect(currentWakeRuleSources(getWakeRuleSources(), source.measuredAt)).toHaveLength(1);
        expect(currentWakeRuleSources(getWakeRuleSources(), source.measuredAt + 13_001)).toHaveLength(0);
        publishWakeRuleSources(scope, [source]);
        expect(currentWakeRuleSources(getWakeRuleSources(), source.measuredAt + 13_001)).toHaveLength(0);
        expect(currentWakeRuleSources(getWakeRuleSources(), source.measuredAt - 1001)).toHaveLength(0);
    });
    it('bounds/refuses duplicate or malformed choices and clears at the account fence', () => {
        const source = option(),
            scope = getAuthIdentityScope();
        for (const options of [
            [source, source],
            Array.from({ length: 33 }, () => source),
            [{ ...source, selection: { ...source.selection, reference: 'apparent' } }],
            [{ ...source, measuredAt: NaN }],
            [{ ...source, label: 'x'.repeat(81) }],
        ])
            expect(publishWakeRuleSources(scope, options)).toBe(false);
        publishWakeRuleSources(scope, [source]);
        setAuthIdentityScope('generated-source-swap');
        expect(getWakeRuleSources().options).toHaveLength(0);
        expect(publishWakeRuleSources(scope, [source])).toBe(false);
    });
});
