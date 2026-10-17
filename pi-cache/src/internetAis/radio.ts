import { internetAisSourceRef } from '../internetAisWire.js';

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
function internetLeaf(value: unknown): boolean {
    const leaf = record(value);
    return internetAisSourceRef(leaf?.$source) || internetAisSourceRef(record(leaf?.source)?.label);
}
function radioLeaf(value: unknown, now: number): unknown {
    const leaf = record(value);
    // Untagged legacy receiver leaves retain their original behavior. A known
    // internet-selected leaf can use only an original non-internet alternative.
    if (!leaf || !internetLeaf(leaf)) return value;
    const alternatives = record(leaf.values);
    if (!alternatives || Object.keys(alternatives).length > 32) return null;
    let best: { value: unknown; timestamp: string; $source: string } | null = null;
    let newest = -Infinity;
    for (const [source, raw] of Object.entries(alternatives)) {
        const candidate = record(raw);
        const at = typeof candidate?.timestamp === 'string' ? Date.parse(candidate.timestamp) : NaN;
        if (
            !/^[A-Za-z\d:._/-]{1,160}$/.test(source) ||
            internetAisSourceRef(source) ||
            internetLeaf(candidate) ||
            !candidate ||
            !('value' in candidate) ||
            !Number.isFinite(at) ||
            at > now + 60_000 ||
            now - at > 600_000 ||
            at <= newest
        )
            continue;
        best = { value: candidate.value, timestamp: candidate.timestamp as string, $source: source };
        newest = at;
    }
    return best;
}
/** Read-only projection for existing radio/watch readers; never mixes an internet-selected dynamic leaf into RF. */
export function radioAisDocument(value: unknown, now: number): unknown {
    const doc = record(value);
    if (!doc) return value;
    const navigation = record(doc.navigation),
        communication = record(doc.communication),
        ais = record(communication?.ais);
    const result = { ...doc };
    if (navigation) {
        const next = { ...navigation };
        for (const key of ['position', 'speedOverGround', 'courseOverGroundTrue', 'headingTrue', 'state'])
            next[key] = radioLeaf(navigation[key], now);
        result.navigation = next;
    }
    if (communication && ais)
        result.communication = {
            ...communication,
            ais: { ...ais, safetyRelatedBroadcast: radioLeaf(ais.safetyRelatedBroadcast, now) },
        };
    return result;
}
