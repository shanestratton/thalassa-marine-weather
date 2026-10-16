/** Fixed Signal K preset inputs, in SI at the boundary. No requests or commands.
 * Paths/units: https://signalk.org/specification/1.5.0/doc/vesselsBranch.html
 * Mirrored with wakeRule.ts so a Pi and phone cannot grade different inputs.
 */
import { observedTendency, type PressureSample } from './barometerTendency';
import {
    evaluateWakeRule,
    validWakeRule,
    WAKE_PRESETS,
    type WakeEvaluation,
    type WakeReading,
    type WakeRule,
    type WakeSelection,
    type WakeState,
} from './wakeRule';

export interface WakePressureHistory {
    feedId: string;
    sensorId: string;
    /** Same measured station-pressure source throughout, never MSL forecasts. */
    samples: (PressureSample & { feedId: string; sensorId: string })[];
}
export interface WakeInputContext {
    feedId: string;
    /** Must be the approved local boat feed, not a cloud row or generic gauge. */
    localBoatSource: boolean;
    selfDocument: unknown;
    now: number;
    draftM: number | null;
    pressureHistory?: WakePressureHistory | null;
}
interface Leaf {
    value: number;
    at: number;
    source: string;
    depthBasis?: WakeReading['depthBasis'];
}
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function nodeAt(document: unknown, path: string): unknown {
    let node = document;
    for (const key of path.split('.')) {
        if (!record(node)) return null;
        if (!Object.hasOwn(node, key) && Object.hasOwn(node, 'value') && record(node.value)) node = node.value;
        if (!record(node) || !Object.hasOwn(node, key)) return null;
        node = node[key];
    }
    return node;
}
function leafAt(context: WakeInputContext, path: string, unit: string, sensorId: string, maxAge: number): Leaf | null {
    const leaf = nodeAt(context.selfDocument, path);
    if (
        !record(leaf) ||
        !['value', 'timestamp', '$source'].every((key) => Object.hasOwn(leaf, key)) ||
        typeof leaf.value !== 'number' ||
        !Number.isFinite(leaf.value) ||
        typeof leaf.timestamp !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(leaf.timestamp) ||
        typeof leaf.$source !== 'string' ||
        leaf.$source.length < 1 ||
        leaf.$source.length > 120 ||
        leaf.$source !== sensorId
    )
        return null;
    const at = Date.parse(leaf.timestamp);
    if (!Number.isSafeInteger(at) || at <= 0 || at > context.now + 1000 || context.now - at > maxAge) return null;
    if (record(leaf.meta) && leaf.meta.units !== undefined && leaf.meta.units !== unit) return null;
    return { value: leaf.value, at, source: leaf.$source };
}

/** Retains negative below-keel readings. Unknown offsets take the full draft,
 * exactly the conservative keelOffsetFor policy; they never add tide credit.
 * DBS is unusable if any keel setting remains, matching trackSignalk.readDepth.
 */
function depth(context: WakeInputContext, selection: WakeSelection, maxAge: number): Leaf | null {
    const read = (path: string) => leafAt(context, 'environment.depth.' + path, 'm', selection.sensorId, maxAge);
    const keel = read('belowKeel'),
        raw = read('belowTransducer');
    if (keel && keel.value >= -5 && (!raw || raw.at - keel.at <= 10_000)) return { ...keel, depthBasis: 'below-keel' };
    if (raw && raw.value >= 0) {
        const offset = read('transducerToKeel');
        if (offset && offset.value > 0 && offset.value <= 5 && raw.at - offset.at <= 10_000)
            return {
                ...raw,
                value: raw.value - offset.value,
                at: Math.min(raw.at, offset.at),
                depthBasis: 'transducer-offset',
            };
        if (
            typeof context.draftM === 'number' &&
            Number.isFinite(context.draftM) &&
            context.draftM > 0 &&
            context.draftM <= 20
        )
            return { ...raw, value: raw.value - context.draftM, depthBasis: 'conservative-full-draft' };
        return null;
    }
    // Do not mistake a sounder's keel-configured DBS for a waterline reading.
    if (
        nodeAt(context.selfDocument, 'environment.depth.belowKeel') ||
        nodeAt(context.selfDocument, 'environment.depth.transducerToKeel')
    )
        return null;
    const surface = read('belowSurface');
    return surface &&
        surface.value >= 0 &&
        typeof context.draftM === 'number' &&
        Number.isFinite(context.draftM) &&
        context.draftM > 0 &&
        context.draftM <= 20
        ? { ...surface, value: surface.value - context.draftM, depthBasis: 'conservative-full-draft' }
        : null;
}

/** All paths are chosen by the preset, never accepted from settings. */
export function wakeReadingFromSignalK(rule: WakeRule, context: WakeInputContext): WakeReading | null {
    if (
        !validWakeRule(rule) ||
        !context.localBoatSource ||
        context.feedId !== rule.selection!.feedId ||
        !Number.isFinite(context.now) ||
        context.now <= 0
    )
        return null;
    const selection = rule.selection!,
        maxAge = WAKE_PRESETS[rule.preset].maxAge;
    const read = (path: string, unit: string) => leafAt(context, path, unit, selection.sensorId, maxAge);
    let leaf: Leaf | null = null;
    switch (rule.preset) {
        case 'depth-below-keel':
            leaf = depth(context, selection, maxAge);
            break;
        case 'wind-above': {
            // Explicit true wind over water; apparent/ground wind is not substituted.
            const wind = read('environment.wind.speedTrue', 'm/s');
            leaf = wind ? { ...wind, value: (wind.value * 3600) / 1852 } : null;
            break;
        }
        case 'speed-below': {
            const speed = read('navigation.speedOverGround', 'm/s');
            leaf = speed ? { ...speed, value: (speed.value * 3600) / 1852 } : null;
            break;
        }
        case 'pressure-fall': {
            const pressure = read('environment.outside.pressure', 'Pa'),
                history = context.pressureHistory;
            if (
                !pressure ||
                pressure.value < 80_000 ||
                pressure.value > 110_000 ||
                !history ||
                history.feedId !== selection.feedId ||
                history.sensorId !== selection.sensorId ||
                !Array.isArray(history.samples) ||
                history.samples.length > 2048
            )
                break;
            const samples = history.samples;
            if (
                samples.some(
                    (sample, index) =>
                        !record(sample) ||
                        sample.feedId !== selection.feedId ||
                        sample.sensorId !== selection.sensorId ||
                        !Number.isSafeInteger(sample.t) ||
                        sample.t <= 0 ||
                        sample.t > pressure.at ||
                        !Number.isFinite(sample.hpa) ||
                        sample.hpa < 800 ||
                        sample.hpa > 1100 ||
                        (index > 0 && sample.t <= samples[index - 1].t),
                )
            )
                break;
            // The live leaf must itself be in this source's bounded history.
            if (!samples.some((sample) => sample.t === pressure.at && sample.hpa === pressure.value / 100)) break;
            const tendency = observedTendency(samples, pressure.at);
            if (tendency) leaf = { ...pressure, value: -tendency.delta3h };
            break;
        }
        case 'engine-rpm-above':
        case 'engine-coolant-above':
        case 'engine-oil-below': {
            const propulsion = nodeAt(context.selfDocument, 'propulsion');
            // Initial presets support one identified engine only; never pick the first.
            if (!record(propulsion)) break;
            const instances = Object.keys(propulsion).filter(
                (key) => key !== 'meta' && key !== 'timestamp' && key !== '$source' && key !== 'value',
            );
            if (instances.length !== 1 || instances[0] !== selection.instance) break;
            const base = 'propulsion.' + selection.instance + '.';
            if (rule.preset === 'engine-rpm-above') {
                const rpm = read(base + 'revolutions', 'Hz');
                leaf = rpm ? { ...rpm, value: rpm.value * 60 } : null;
            } else if (rule.preset === 'engine-coolant-above') {
                const coolant = read(base + 'coolantTemperature', 'K');
                leaf = coolant ? { ...coolant, value: coolant.value - 273.15 } : null;
            } else {
                const oil = read(base + 'oilPressure', 'Pa');
                const rpm = leafAt(context, base + 'revolutions', 'Hz', selection.sensorId, maxAge);
                // An engine off, missing RPM or incoherent leaves is unknown, not low oil.
                if (oil && rpm && rpm.value > 0 && rpm.value <= 20000 / 60 && Math.abs(oil.at - rpm.at) <= 6000)
                    leaf = { ...oil, value: oil.value / 1000, at: Math.min(oil.at, rpm.at) };
            }
            break;
        }
        case 'battery-below':
            leaf = read('electrical.batteries.' + selection.instance + '.voltage', 'V');
            break;
    }
    const spec = WAKE_PRESETS[rule.preset];
    if (!leaf || !Number.isFinite(leaf.value) || leaf.value < spec.min || leaf.value > spec.max) return null;
    return {
        preset: rule.preset,
        selection: { ...selection },
        value: leaf.value,
        at: leaf.at,
        ...(leaf.depthBasis ? { depthBasis: leaf.depthBasis } : {}),
    };
}

export function evaluateWakeFromSignalK(
    rule: WakeRule,
    previous: WakeState,
    context: WakeInputContext,
): WakeEvaluation {
    return evaluateWakeRule(rule, previous, wakeReadingFromSignalK(rule, context), context.now);
}
