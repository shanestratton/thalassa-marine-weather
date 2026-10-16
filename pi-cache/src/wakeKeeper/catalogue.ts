import {
    defaultWakeRules,
    WAKE_PRESETS,
    type WakePreset,
    type WakeRule,
    type WakeSelection,
} from '../wakeRule/wakeRule.js';
import { wakeReadingFromSignalK, type WakeInputContext } from '../wakeRule/wakeRuleInputs.js';
import { wakeRecord, sameWakeSelection, WAKE_SENSOR_CAP, type WakeSensorOption } from './contract.js';

const BAD = new Set(['__proto__', 'prototype', 'constructor']);
function node(document: unknown, path: string): Record<string, unknown> | null {
    let current = document;
    for (const key of path.split('.')) {
        if (!wakeRecord(current)) return null;
        if (!Object.hasOwn(current, key) && wakeRecord(current.value)) current = current.value;
        if (!wakeRecord(current) || !Object.hasOwn(current, key)) return null;
        current = current[key];
    }
    return wakeRecord(current) ? current : null;
}
function source(document: unknown, path: string): string | null {
    const id = node(document, path)?.$source;
    return typeof id === 'string' && /^[A-Za-z0-9:._/-]{1,120}$/.test(id) ? id : null;
}
const titles: Record<WakePreset, string> = {
    'depth-below-keel': 'Depth under keel',
    'wind-above': 'True wind over water',
    'speed-below': 'Speed over ground',
    'pressure-fall': 'Measured pressure',
    'engine-coolant-above': 'Engine coolant',
    'engine-oil-below': 'Engine oil pressure',
    'engine-rpm-above': 'Engine RPM',
    'battery-below': 'Battery voltage',
};
function label(preset: WakePreset, selected: WakeSelection, warming: boolean): string {
    const value = `${titles[preset]}${warming ? ' · history warming' : ''}${selected.instance ? ` · ${selected.instance}` : ''} · ${selected.sensorId}`;
    return value.length <= 80 ? value : value.slice(0, 79) + '…';
}
/** One measured physical station-pressure leaf, never a forecast/parent clock. */
export function wakeStationPressure(context: WakeInputContext): { sensorId: string; t: number; hpa: number } | null {
    if (
        !context.localBoatSource ||
        !Number.isSafeInteger(context.now) ||
        context.now <= 0 ||
        !context.feedId ||
        context.feedId.length > 120
    )
        return null;
    const pressure = node(context.selfDocument, 'environment.outside.pressure'),
        sensorId = source(context.selfDocument, 'environment.outside.pressure');
    const at =
        typeof pressure?.timestamp === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(pressure.timestamp)
            ? Date.parse(pressure.timestamp)
            : NaN;
    const unit = wakeRecord(pressure?.meta) ? pressure.meta.units : undefined;
    return sensorId &&
        typeof pressure?.value === 'number' &&
        Number.isFinite(pressure.value) &&
        pressure.value >= 80000 &&
        pressure.value <= 110000 &&
        (unit === undefined || unit === 'Pa') &&
        Number.isSafeInteger(at) &&
        at > 0 &&
        at <= context.now + 1000 &&
        context.now - at <= WAKE_PRESETS['pressure-fall'].maxAge
        ? { sensorId, t: at, hpa: pressure.value / 100 }
        : null;
}
/** Discover only actual fixed-preset leaves from the authenticated cache.
 * No path supplied by a phone, no first-engine/bank selection, no provider values. */
export function wakeSensorCatalogue(context: WakeInputContext): { options: WakeSensorOption[]; truncated: boolean } {
    const options: WakeSensorOption[] = [];
    let truncated = false;
    if (
        !context.localBoatSource ||
        !Number.isSafeInteger(context.now) ||
        context.now <= 0 ||
        !context.feedId ||
        context.feedId.length > 120
    )
        return { options, truncated };
    const add = (preset: WakePreset, sensorId: string, instance?: string) => {
        const selected: WakeSelection = {
            feedId: context.feedId,
            sensorId,
            reference: WAKE_PRESETS[preset].reference,
            ...(instance ? { instance } : {}),
        };
        if (options.some((o) => o.preset === preset && sameWakeSelection(o.selection, selected))) return;
        const base = defaultWakeRules().find((r) => r.preset === preset)!;
        const rule: WakeRule = {
            ...base,
            enabled: true,
            selection: selected,
            threshold: base.threshold ?? WAKE_PRESETS[preset].thresholdMin,
        };
        const reading = wakeReadingFromSignalK(rule, context);
        let measuredAt = reading?.at ?? null,
            warming = false;
        // An existing station-pressure sensor is selectable before it has the
        // necessary measured history. Its tendency/evaluation remains unknown.
        if (preset === 'pressure-fall' && !reading) {
            const pressure = wakeStationPressure(context);
            if (pressure?.sensorId === sensorId) {
                measuredAt = pressure.t;
                warming = true;
            }
        }
        if (measuredAt === null) return;
        if (options.length >= WAKE_SENSOR_CAP) {
            truncated = true;
            return;
        }
        options.push({ preset, selection: selected, label: label(preset, selected, warming), measuredAt, reading });
    };
    const fixed: [WakePreset, string][] = [
        ['depth-below-keel', 'environment.depth.belowKeel'],
        ['depth-below-keel', 'environment.depth.belowTransducer'],
        ['depth-below-keel', 'environment.depth.belowSurface'],
        ['wind-above', 'environment.wind.speedTrue'],
        ['speed-below', 'navigation.speedOverGround'],
        ['pressure-fall', 'environment.outside.pressure'],
    ];
    for (const [preset, path] of fixed) {
        const id = source(context.selfDocument, path);
        if (id) add(preset, id);
    }
    const propulsion = node(context.selfDocument, 'propulsion');
    const engines = Object.keys(propulsion ?? {}).filter(
        (key) => !['meta', 'timestamp', '$source', 'value'].includes(key),
    );
    if (engines.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(engines[0]) && !BAD.has(engines[0])) {
        const instance = engines[0];
        const fields: [WakePreset, string][] = [
            ['engine-coolant-above', 'coolantTemperature'],
            ['engine-oil-below', 'oilPressure'],
            ['engine-rpm-above', 'revolutions'],
        ];
        for (const [preset, leaf] of fields) {
            const id = source(context.selfDocument, `propulsion.${instance}.${leaf}`);
            if (id) add(preset, id, instance);
        }
    }
    const batteries = node(context.selfDocument, 'electrical.batteries');
    const banks = Object.keys(batteries ?? {})
        .filter(
            (id) =>
                !['meta', 'timestamp', '$source', 'value'].includes(id) &&
                /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
                !BAD.has(id),
        )
        .sort();
    if (banks.length > 16) truncated = true;
    for (const instance of banks.slice(0, 16)) {
        const id = source(context.selfDocument, `electrical.batteries.${instance}.voltage`);
        if (id) add('battery-below', id, instance);
    }
    return { options, truncated };
}
