import React, { useRef, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    copyWakeRule,
    getWakeRulePreferences,
    saveWakeRulePreferences,
    useWakeRulePreferences,
    validWakeDraft,
    type WakeRulePreferences,
} from '../../services/alarms/wakeRulePreferences';
import {
    currentWakeRuleSources,
    getWakeRuleSources,
    useWakeRuleSources,
    wakeSourceKey,
    type WakeSourceOption,
} from '../../services/alarms/wakeRuleSources';
import { validWakeRule, WAKE_PRESETS, wakeRuleKey, type WakePreset, type WakeRule } from '../../utils/wakeRule';

const LABELS: Record<WakePreset, string> = {
    'depth-below-keel': 'Depth below keel',
    'wind-above': 'True wind above',
    'speed-below': 'Ground speed below',
    'pressure-fall': 'Pressure fall / 3 h',
    'engine-coolant-above': 'Engine coolant above',
    'engine-oil-below': 'Engine oil pressure below',
    'engine-rpm-above': 'Engine RPM above',
    'battery-below': 'Battery voltage below',
};
const REFERENCES: Record<WakePreset, string> = {
    'depth-below-keel': 'Below keel',
    'wind-above': 'True wind over water',
    'speed-below': 'Speed over ground',
    'pressure-fall': 'Measured station pressure / 3 h',
    'engine-coolant-above': 'Coolant temperature',
    'engine-oil-below': 'Oil pressure; same-engine RPM',
    'engine-rpm-above': 'Identified engine RPM',
    'battery-below': 'Selected bank voltage',
};
const FIELD = 'w-full min-w-0 min-h-[44px] rounded-lg border border-white/15 bg-slate-950 px-2 text-sm text-white';
const LABEL = 'block min-w-0 text-xs text-gray-300';
const offsets = Array.from({ length: 113 }, (_, index) => -840 + index * 15);
const timeText = (minute: number) =>
    Number.isInteger(minute)
        ? `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
        : '';
const minuteValue = (text: string) =>
    /^\d\d:\d\d$/.test(text) ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : NaN;
const offsetText = (value: number) =>
    `UTC${value < 0 ? '-' : '+'}${String(Math.floor(Math.abs(value) / 60)).padStart(2, '0')}:${String(Math.abs(value) % 60).padStart(2, '0')}`;
function sourcesPermit(
    rules: readonly WakeRule[],
    saved: readonly WakeRule[],
    options: readonly WakeSourceOption[],
): boolean {
    return rules.every(
        (rule) =>
            !rule.enabled ||
            saved.some((old) => old.enabled && wakeRuleKey(old) === wakeRuleKey(rule)) ||
            (!!rule.selection &&
                options.some(
                    (option) =>
                        wakeSourceKey(option.preset, option.selection) === wakeSourceKey(rule.preset, rule.selection!),
                )),
    );
}

function RuleForm({ preferences, onClose }: { preferences: WakeRulePreferences; onClose: () => void }) {
    const [rules, setRules] = useState(() => preferences.rules.map(copyWakeRule));
    const [preset, setPreset] = useState<WakePreset>('depth-below-keel');
    const [message, setMessage] = useState('');
    const baseline = useRef(preferences.rules);
    const sources = useWakeRuleSources();
    const rule = rules.find((item) => item.preset === preset)!;
    const spec = WAKE_PRESETS[preset];
    const options = sources.filter((option) => option.preset === preset);
    const selected = rule.selection ? wakeSourceKey(preset, rule.selection) : '';
    const available = options.some((option) => wakeSourceKey(preset, option.selection) === selected);
    const canEnable = available && validWakeRule({ ...rule, enabled: true });
    const externalChange = JSON.stringify(preferences.rules) !== JSON.stringify(baseline.current);
    const ready = rules.every(validWakeDraft) && sourcesPermit(rules, baseline.current, sources) && !externalChange;
    const change = (patch: Partial<WakeRule>) => {
        setRules((previous) => previous.map((item) => (item.preset === preset ? { ...item, ...patch } : item)));
        setMessage('');
    };
    const save = () => {
        const latest = getWakeRulePreferences();
        if (
            latest.scope.key !== preferences.scope.key ||
            latest.scope.generation !== preferences.scope.generation ||
            JSON.stringify(latest.rules) !== JSON.stringify(baseline.current) ||
            !sourcesPermit(rules, baseline.current, currentWakeRuleSources(getWakeRuleSources(), Date.now()))
        ) {
            setMessage('Sources or saved rules changed. Review them before saving.');
            return;
        }
        if (!saveWakeRulePreferences(rules, preferences.scope)) {
            setMessage('Could not save. Existing saved rules remain in effect.');
            return;
        }
        baseline.current = getWakeRulePreferences().rules;
        setMessage('Saved.');
    };
    const numeric = (
        key: 'threshold' | 'hysteresis' | 'minimumDurationMs' | 'clearDurationMs',
        label: string,
        scale = 1,
    ) => (
        <label className={LABEL}>
            {label}
            <input
                type="number"
                inputMode="decimal"
                className={`${FIELD} mt-1`}
                value={rule[key] !== null && Number.isFinite(rule[key]) ? rule[key]! / scale : ''}
                min={key === 'threshold' ? spec.thresholdMin : 0}
                max={key === 'threshold' || key === 'hysteresis' ? spec.thresholdMax : 3600}
                step="any"
                onChange={(event) =>
                    change({
                        [key]:
                            event.target.value === ''
                                ? key === 'threshold'
                                    ? null
                                    : NaN
                                : Number(event.target.value) * scale,
                    })
                }
            />
        </label>
    );
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title="Wake rules"
            maxWidth="max-w-md"
            zIndex="z-2000"
            fitViewport
            footer={
                <div className="space-y-2">
                    <p role="status" className="text-xs text-amber-200">
                        {message ||
                            (externalChange
                                ? 'Saved rules changed. Close and reopen to reload.'
                                : preferences.unreadable
                                  ? 'Storage unreadable. Last valid rules are retained.'
                                  : !ready
                                    ? 'Choose live sources and valid values before enabling.'
                                    : 'Changes apply only when you save.')}
                    </p>
                    <button
                        type="button"
                        className="w-full min-h-[44px] rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-40"
                        disabled={!ready}
                        onClick={save}
                    >
                        Save rules
                    </button>
                </div>
            }
        >
            <div className="space-y-2">
                <p className="text-xs text-gray-400">Phone watch needs the app active. Pi keeper not confirmed.</p>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                    <label className={LABEL}>
                        Preset
                        <select
                            aria-label="Preset"
                            className={`${FIELD} thalassa-select appearance-none mt-1 pr-8`}
                            value={preset}
                            onChange={(event) => {
                                setPreset(event.target.value as WakePreset);
                                setMessage('');
                            }}
                        >
                            {(Object.keys(WAKE_PRESETS) as WakePreset[]).map((name) => (
                                <option key={name} value={name}>
                                    {LABELS[name]}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex min-h-[44px] items-center gap-2 text-sm text-white">
                        <input
                            type="checkbox"
                            aria-label="Enable selected wake rule"
                            checked={rule.enabled}
                            disabled={!rule.enabled && !canEnable}
                            onChange={(event) => change({ enabled: event.target.checked })}
                        />
                        On
                    </label>
                </div>
                <p className="text-xs text-gray-300">{LABELS[preset]}</p>
                <div>
                    <label className={LABEL}>
                        Sensor source
                        <select
                            aria-label="Sensor source"
                            className={`${FIELD} thalassa-select appearance-none mt-1 pr-8`}
                            value={selected}
                            onChange={(event) => {
                                const option = options.find(
                                    (item) => wakeSourceKey(preset, item.selection) === event.target.value,
                                );
                                change({ selection: option ? { ...option.selection } : null });
                            }}
                        >
                            <option value="">Choose a qualified source</option>
                            {selected && !available && <option value={selected}>Saved source unavailable</option>}
                            {options.map((option) => (
                                <option
                                    key={wakeSourceKey(preset, option.selection)}
                                    value={wakeSourceKey(preset, option.selection)}
                                >
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {available && (
                        <p className="mt-1 break-words text-xs text-gray-300">
                            {options.find((option) => wakeSourceKey(preset, option.selection) === selected)!.label}
                        </p>
                    )}
                    <p className="mt-1 break-words text-xs text-gray-400">
                        {rule.selection ? (
                            <>
                                <span className="break-all">{rule.selection.sensorId}</span> &middot;{' '}
                                {REFERENCES[preset]}
                                {rule.selection.instance && (
                                    <>
                                        {' '}
                                        &middot; {preset === 'battery-below' ? 'Bank' : 'Engine'}{' '}
                                        {rule.selection.instance}
                                    </>
                                )}
                            </>
                        ) : (
                            REFERENCES[preset]
                        )}
                    </p>
                    {!options.length && (
                        <p className="mt-1 text-xs text-amber-200">
                            No qualified live source. Connect a supported local boat feed.
                        </p>
                    )}
                    {preset === 'pressure-fall' && (
                        <p className="mt-1 text-xs text-gray-400">
                            Pressure fall stays unknown while measured history is collecting.
                        </p>
                    )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                    {numeric('threshold', `Threshold (${spec.unit})`)}
                    {numeric('hysteresis', `Hysteresis (${spec.unit})`)}
                </div>
                <div className="grid grid-cols-2 gap-2">
                    {numeric('minimumDurationMs', 'Minimum hold (s)', 1000)}
                    {numeric('clearDurationMs', 'Clear hold (s)', 1000)}
                </div>
                <div>
                    <label className="flex min-h-[44px] items-center gap-2 text-sm text-white">
                        <input
                            type="checkbox"
                            checked={!!rule.quietHours}
                            onChange={(event) =>
                                change({
                                    quietHours: event.target.checked
                                        ? { startMinute: 1320, endMinute: 360, utcOffsetMinutes: 0 }
                                        : null,
                                })
                            }
                        />
                        Quiet hours
                    </label>
                    {rule.quietHours && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <label className={LABEL}>
                                    Start
                                    <input
                                        className={`${FIELD} mt-1 px-1`}
                                        type="time"
                                        value={timeText(rule.quietHours.startMinute)}
                                        onChange={(event) =>
                                            change({
                                                quietHours: {
                                                    ...rule.quietHours!,
                                                    startMinute: minuteValue(event.target.value),
                                                },
                                            })
                                        }
                                    />
                                </label>
                                <label className={LABEL}>
                                    End
                                    <input
                                        className={`${FIELD} mt-1 px-1`}
                                        type="time"
                                        value={timeText(rule.quietHours.endMinute)}
                                        onChange={(event) =>
                                            change({
                                                quietHours: {
                                                    ...rule.quietHours!,
                                                    endMinute: minuteValue(event.target.value),
                                                },
                                            })
                                        }
                                    />
                                </label>
                                <label className={`${LABEL} col-span-2`}>
                                    UTC offset
                                    <select
                                        aria-label="UTC offset"
                                        className={`${FIELD} thalassa-select appearance-none mt-1 pl-1 pr-8`}
                                        value={rule.quietHours.utcOffsetMinutes}
                                        onChange={(event) =>
                                            change({
                                                quietHours: {
                                                    ...rule.quietHours!,
                                                    utcOffsetMinutes: Number(event.target.value),
                                                },
                                            })
                                        }
                                    >
                                        {!offsets.includes(rule.quietHours.utcOffsetMinutes) && (
                                            <option value={rule.quietHours.utcOffsetMinutes}>
                                                {offsetText(rule.quietHours.utcOffsetMinutes)}
                                            </option>
                                        )}
                                        {offsets.map((offset) => (
                                            <option key={offset} value={offset}>
                                                {offsetText(offset)}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <p className="mt-1 text-xs text-gray-400">
                                Fixed offset; update it when clocks change. Suppresses this rule&apos;s delivery.
                            </p>
                        </>
                    )}
                </div>
            </div>
        </ModalSheet>
    );
}
export default function WakeRulesEditor({ onClose }: { onClose: () => void }) {
    const preferences = useWakeRulePreferences();
    return (
        <RuleForm
            key={`${preferences.scope.key}:${preferences.scope.generation}`}
            preferences={preferences}
            onClose={onClose}
        />
    );
}
