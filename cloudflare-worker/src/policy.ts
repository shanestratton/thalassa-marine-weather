export const MAX_SESSION_MS = 5 * 60 * 1000;
export const UPSTREAM_HANDSHAKE_MS = 10_000;
export const TICKET_LOOKUP_MS = 5_000;
export const MAX_CLIENT_BYTES = 25_000_000;
export const MAX_UPSTREAM_BYTES = 10_000_000;
export const MAX_FRAME_BYTES = 1_000_000;
export const MAX_CONTROL_BYTES = 4_096;

const ALLOWED_CONTROL_TYPES = new Set(['KeepAlive', 'CloseStream', 'Finalize']);
const REQUIRED_SCALARS = [
    'model',
    'encoding',
    'sample_rate',
    'channels',
    'interim_results',
    'smart_format',
    'endpointing',
    'language',
    'vad_events',
    'punctuate',
] as const;
const ALLOWED_PARAMS = new Set([...REQUIRED_SCALARS, 'keyterm', 'ticket']);

export interface AcceptedFrame {
    accepted: true;
    data: ArrayBuffer | string;
    bytes: number;
}

export interface RejectedFrame {
    accepted: false;
    closeCode: 1008 | 1009;
    reason: string;
}

export type FrameDecision = AcceptedFrame | RejectedFrame;

export function isProxyTicket(value: string | null): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function boundedDeepgramParams(incoming: URL): URLSearchParams | null {
    if (incoming.search.length > 2_048) return null;
    for (const key of incoming.searchParams.keys()) {
        if (!ALLOWED_PARAMS.has(key)) return null;
    }
    for (const key of REQUIRED_SCALARS) {
        if (incoming.searchParams.getAll(key).length !== 1) return null;
    }
    if (incoming.searchParams.getAll('ticket').length !== 1) return null;

    const sampleRate = Number(incoming.searchParams.get('sample_rate'));
    const endpointing = Number(incoming.searchParams.get('endpointing'));
    if (
        incoming.searchParams.get('model') !== 'nova-3' ||
        incoming.searchParams.get('encoding') !== 'linear16' ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 8_000 ||
        sampleRate > 48_000 ||
        incoming.searchParams.get('channels') !== '1' ||
        !Number.isInteger(endpointing) ||
        endpointing < 100 ||
        endpointing > 2_000 ||
        incoming.searchParams.get('language') !== 'en-AU'
    ) {
        return null;
    }
    for (const flag of ['interim_results', 'smart_format', 'vad_events', 'punctuate']) {
        if (incoming.searchParams.get(flag) !== 'true') return null;
    }

    const keyterms = incoming.searchParams.getAll('keyterm');
    if (
        keyterms.length > 10 ||
        keyterms.some((term) => term.length < 1 || term.length > 64 || !/^[\p{L}\p{N} .'-]+$/u.test(term))
    ) {
        return null;
    }

    const forwarded = new URLSearchParams({
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: String(endpointing),
        language: 'en-AU',
        vad_events: 'true',
        punctuate: 'true',
    });
    for (const term of keyterms) forwarded.append('keyterm', term);
    return forwarded;
}

export function frameByteLength(data: unknown): number | null {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
    return null;
}

export function validateClientFrame(data: unknown, bytesSoFar: number): FrameDecision {
    if (!(data instanceof ArrayBuffer) && typeof data !== 'string') {
        return { accepted: false, closeCode: 1008, reason: 'unsupported frame type' };
    }
    const bytes = frameByteLength(data)!;
    if (bytes > MAX_FRAME_BYTES || bytesSoFar > MAX_CLIENT_BYTES - bytes) {
        return { accepted: false, closeCode: 1009, reason: 'audio limit exceeded' };
    }
    if (typeof data === 'string') {
        if (bytes > MAX_CONTROL_BYTES) {
            return { accepted: false, closeCode: 1009, reason: 'control frame too large' };
        }
        try {
            const parsed = JSON.parse(data) as unknown;
            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed) ||
                !ALLOWED_CONTROL_TYPES.has((parsed as { type?: unknown }).type as string)
            ) {
                return { accepted: false, closeCode: 1008, reason: 'invalid control frame' };
            }
        } catch {
            return { accepted: false, closeCode: 1008, reason: 'invalid control frame' };
        }
    }
    return { accepted: true, data, bytes };
}
