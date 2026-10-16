/** Trusted adapter boundary, never a field in a fetched/serialized DTO. A
 * future fixed-source adapter must supply its own actual transport identity,
 * original receipt clock and digest of the response bytes it parsed. */
import { parseSampledTideSeries, type SampledTideProvider, type SampledTideSeries } from './sampledTideContract';
import { canonicalReviewedSourceUrl } from './reviewedSourceUrl';

export interface AdapterSampleReadEvidence {
    readonly provider: SampledTideProvider;
    readonly productId: string;
    readonly requestUrl: string;
    readonly responseUrl: string;
    readonly receivedAtMs: number;
    /** Computed by the adapter from actual response bytes, never copied from JSON. */
    readonly bodySha256: string;
}
const reads = new WeakMap<SampledTideSeries, Readonly<AdapterSampleReadEvidence>>();

/** Only call from a reviewed acquisition adapter with independent evidence.
 * This helper validates/binds evidence; it does not perform or prove a fetch.
 * There are currently no production callers or activated source adapters. */
export function bindAdapterSampledTideSeries(
    raw: unknown,
    evidence: AdapterSampleReadEvidence,
    nowMs: number,
): SampledTideSeries | null {
    const value = parseSampledTideSeries(raw, nowMs);
    if (
        !value ||
        !evidence ||
        evidence.provider !== value.provider ||
        evidence.productId !== value.productId ||
        evidence.receivedAtMs !== value.receivedAtMs ||
        !canonicalReviewedSourceUrl(evidence.requestUrl) ||
        !canonicalReviewedSourceUrl(evidence.responseUrl) ||
        typeof evidence.bodySha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(evidence.bodySha256)
    )
        return null;
    for (const sample of value.samples) Object.freeze(sample);
    Object.freeze(value.samples);
    Object.freeze(value);
    reads.set(
        value,
        Object.freeze({
            provider: evidence.provider,
            productId: evidence.productId,
            requestUrl: evidence.requestUrl,
            responseUrl: evidence.responseUrl,
            receivedAtMs: evidence.receivedAtMs,
            bodySha256: evidence.bodySha256,
        }),
    );
    return value;
}

/** Raw objects, primitive copies and storage round trips have no binding. */
export function adapterSampleReadEvidence(value: SampledTideSeries): Readonly<AdapterSampleReadEvidence> | null {
    return reads.get(value) ?? null;
}
