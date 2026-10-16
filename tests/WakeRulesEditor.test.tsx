import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WakeRulesEditor from '../components/settings/WakeRulesEditor';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { getWakeRulePreferences, saveWakeRulePreferences } from '../services/alarms/wakeRulePreferences';
import { publishWakeRuleSources, type WakeSourceOption } from '../services/alarms/wakeRuleSources';
import { defaultWakeRules } from '../utils/wakeRule';

let owner = 0;
const T = 1_800_000_000_000;
const wind: WakeSourceOption = {
    preset: 'wind-above',
    selection: { feedId: 'pi:generated:verified-vessel', sensorId: 'n2k.wind.17', reference: 'true-water' },
    label: 'Mast wind / N2K 17',
    measuredAt: T,
};
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    localStorage.clear();
    setAuthIdentityScope('wake-editor-generated-' + ++owner);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
const choose = (preset = 'wind-above') =>
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: preset } });
const selectSource = () => {
    const source = screen.getByLabelText('Sensor source');
    const option = within(source).getByRole('option', { name: wind.label }) as HTMLOptionElement;
    fireEvent.change(source, { target: { value: option.value } });
};
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));

describe('wake rule editor configuration boundary', () => {
    it('starts off, invents no source or engine redline, and cannot enable without a qualified selection', () => {
        render(<WakeRulesEditor onClose={vi.fn()} />);
        expect(screen.getByLabelText('Enable selected wake rule')).not.toBeChecked();
        expect(screen.getByLabelText('Enable selected wake rule')).toBeDisabled();
        expect(screen.getByText(/No qualified live source/)).toBeVisible();
        choose('engine-coolant-above');
        expect(screen.getByLabelText('Threshold (C)')).toHaveValue(null);
        expect(screen.getByLabelText('Enable selected wake rule')).toBeDisabled();
        choose('pressure-fall');
        expect(screen.getByText(/measured history is collecting/)).toBeVisible();
        expect(screen.getByText(/Phone only while the app is active/)).toBeVisible();
        expect(getWakeRulePreferences().saved).toBe(false);
    });
    it('saves only on explicit Save, with actual source/reference, holds and fixed-offset quiet hours', () => {
        publishWakeRuleSources(getAuthIdentityScope(), [wind]);
        render(<WakeRulesEditor onClose={vi.fn()} />);
        choose();
        selectSource();
        fireEvent.click(screen.getByLabelText('Enable selected wake rule'));
        fireEvent.change(screen.getByLabelText('Threshold (kn)'), { target: { value: '30' } });
        fireEvent.change(screen.getByLabelText('Hysteresis (kn)'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('Minimum hold (s)'), { target: { value: '90' } });
        fireEvent.change(screen.getByLabelText('Clear hold (s)'), { target: { value: '45' } });
        fireEvent.click(screen.getByLabelText('Quiet hours'));
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '21:30' } });
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '05:45' } });
        fireEvent.change(screen.getByLabelText('UTC offset'), { target: { value: '600' } });
        expect(getWakeRulePreferences().saved).toBe(false);
        save();
        expect(screen.getByRole('status', { name: 'Wake rule save status' })).toHaveTextContent('Saved.');
        expect(getWakeRulePreferences().rules.find((rule) => rule.preset === wind.preset)).toEqual({
            ...defaultWakeRules().find((rule) => rule.preset === wind.preset),
            enabled: true,
            selection: wind.selection,
            threshold: 30,
            hysteresis: 3,
            minimumDurationMs: 90_000,
            clearDurationMs: 45_000,
            quietHours: { startMinute: 1290, endMinute: 345, utcOffsetMinutes: 600 },
        });
    });
    it('rechecks original source time at Save even before the one-second UI refresh', () => {
        publishWakeRuleSources(getAuthIdentityScope(), [wind]);
        render(<WakeRulesEditor onClose={vi.fn()} />);
        choose();
        selectSource();
        fireEvent.click(screen.getByLabelText('Enable selected wake rule'));
        vi.setSystemTime(T + 14_000);
        save();
        expect(screen.getByRole('status', { name: 'Wake rule save status' })).toHaveTextContent(
            'Sources or saved rules changed',
        );
        expect(getWakeRulePreferences().saved).toBe(false);
    });
    it('retains an unavailable enabled rule unchanged and allows explicit disabling', () => {
        const rules = defaultWakeRules();
        Object.assign(rules[1], { enabled: true, selection: wind.selection });
        saveWakeRulePreferences(rules, getAuthIdentityScope());
        render(<WakeRulesEditor onClose={vi.fn()} />);
        choose();
        expect(screen.getByLabelText('Enable selected wake rule')).toBeChecked();
        expect(screen.getByRole('option', { name: 'Saved source unavailable' })).toBeInTheDocument();
        save();
        expect(getWakeRulePreferences().rules[1].enabled).toBe(true);
        fireEvent.click(screen.getByLabelText('Enable selected wake rule'));
        save();
        expect(getWakeRulePreferences().rules[1].enabled).toBe(false);
    });
    it('discards an unsaved previous-account draft and sensor catalogue synchronously', () => {
        publishWakeRuleSources(getAuthIdentityScope(), [wind]);
        render(<WakeRulesEditor onClose={vi.fn()} />);
        choose();
        selectSource();
        fireEvent.change(screen.getByLabelText('Threshold (kn)'), { target: { value: '39' } });
        act(() => setAuthIdentityScope('wake-editor-other-owner'));
        expect(screen.getByLabelText('Preset')).toHaveValue('depth-below-keel');
        choose();
        expect(screen.getByLabelText('Threshold (kn)')).toHaveValue(25);
        expect(screen.queryByRole('option', { name: wind.label })).toBeNull();
        expect(screen.getByLabelText('Enable selected wake rule')).toBeDisabled();
        save();
        expect(getWakeRulePreferences().rules.every((rule) => !rule.enabled && !rule.selection)).toBe(true);
    });
    it('refuses overwriting a newer valid configuration from another window', () => {
        render(<WakeRulesEditor onClose={vi.fn()} />);
        const external = defaultWakeRules();
        external[0].threshold = 8;
        act(() => saveWakeRulePreferences(external, getAuthIdentityScope()));
        expect(screen.getByRole('status', { name: 'Wake rule save status' })).toHaveTextContent('Close and reopen');
        expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
        expect(getWakeRulePreferences().rules[0].threshold).toBe(8);
    });
    it('keeps an active saved rule on corrupted storage and permits a deliberate repair', () => {
        const rules = defaultWakeRules();
        Object.assign(rules[1], { enabled: true, selection: wind.selection });
        saveWakeRulePreferences(rules, getAuthIdentityScope());
        render(<WakeRulesEditor onClose={vi.fn()} />);
        act(() => {
            const key = authScopedStorageKey('thalassa_wake_rules_v1');
            localStorage.setItem(key, '{');
            window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
        });
        expect(screen.getByRole('status', { name: 'Wake rule save status' })).toHaveTextContent(
            'Last valid rules are retained',
        );
        expect(getWakeRulePreferences().rules[1].enabled).toBe(true);
        save();
        expect(screen.getByRole('status', { name: 'Wake rule save status' })).toHaveTextContent('Saved.');
        expect(getWakeRulePreferences().unreadable).toBe(false);
    });
    it('blocks malformed quiet hours and timing values without changing saved rules', () => {
        render(<WakeRulesEditor onClose={vi.fn()} />);
        fireEvent.click(screen.getByLabelText('Quiet hours'));
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '22:00' } });
        expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '06:00' } });
        fireEvent.change(screen.getByLabelText('Minimum hold (s)'), { target: { value: '-1' } });
        expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
        expect(getWakeRulePreferences().saved).toBe(false);
    });
});
