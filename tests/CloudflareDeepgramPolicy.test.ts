import { describe, expect, it } from 'vitest';
import {
    boundedDeepgramParams,
    frameByteLength,
    isProxyTicket,
    MAX_CLIENT_BYTES,
    MAX_CONTROL_BYTES,
    MAX_FRAME_BYTES,
    validateClientFrame,
} from '../cloudflare-worker/src/policy';

const TICKET = 'a'.repeat(64);
const INVALID_QUERY_OVERRIDES: Array<Record<string, string | string[]>> = [
    { arbitrary: 'true' },
    { model: ['nova-3', 'nova-3'] },
    { sample_rate: '96000' },
    { channels: '2' },
    { endpointing: '99' },
    { language: 'en-US' },
    { smart_format: 'false' },
    { keyterm: '<script>' },
    { ticket: [TICKET, TICKET] },
];

function validUrl(overrides: Record<string, string | string[]> = {}): URL {
    const values: Record<string, string | string[]> = {
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: '48000',
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '300',
        language: 'en-AU',
        vad_events: 'true',
        punctuate: 'true',
        keyterm: ['Calypso', 'over'],
        ticket: TICKET,
        ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(values)) {
        for (const value of Array.isArray(raw) ? raw : [raw]) params.append(key, value);
    }
    return new URL(`https://voice.example.test/?${params}`);
}

describe('Cloudflare Deepgram proxy policy', () => {
    it('rebuilds one bounded Nova-3 contract and never forwards authorization', () => {
        const params = boundedDeepgramParams(validUrl());
        expect(params?.get('model')).toBe('nova-3');
        expect(params?.get('sample_rate')).toBe('48000');
        expect(params?.getAll('keyterm')).toEqual(['Calypso', 'over']);
        expect(params?.has('ticket')).toBe(false);
    });

    it.each(INVALID_QUERY_OVERRIDES)('rejects unknown, duplicate, or out-of-contract query values: %o', (override) => {
        expect(boundedDeepgramParams(validUrl(override))).toBeNull();
    });

    it('requires the exact one-use ticket format', () => {
        expect(isProxyTicket(TICKET)).toBe(true);
        expect(isProxyTicket('A'.repeat(64))).toBe(false);
        expect(isProxyTicket('a'.repeat(63))).toBe(false);
        expect(isProxyTicket(null)).toBe(false);
    });

    it('accepts bounded PCM and the explicit Deepgram control messages', () => {
        const pcm = new ArrayBuffer(4096);
        expect(validateClientFrame(pcm, 0)).toEqual({ accepted: true, data: pcm, bytes: 4096 });
        expect(validateClientFrame('{"type":"KeepAlive"}', 4096)).toMatchObject({
            accepted: true,
            bytes: 20,
        });
        expect(validateClientFrame('{"type":"Finalize"}', 0)).toMatchObject({ accepted: true });
        expect(validateClientFrame('{"type":"CloseStream"}', 0)).toMatchObject({ accepted: true });
    });

    it('rejects arbitrary controls, unsupported frame types, and per-frame/session overruns', () => {
        expect(validateClientFrame('{"type":"ChangeModel","model":"expensive"}', 0)).toMatchObject({
            accepted: false,
            closeCode: 1008,
        });
        expect(validateClientFrame('not json', 0)).toMatchObject({ accepted: false, closeCode: 1008 });
        expect(validateClientFrame(new Blob(['audio']), 0)).toMatchObject({ accepted: false, closeCode: 1008 });
        expect(validateClientFrame('x'.repeat(MAX_CONTROL_BYTES + 1), 0)).toMatchObject({
            accepted: false,
            closeCode: 1009,
        });
        expect(validateClientFrame(new ArrayBuffer(MAX_FRAME_BYTES + 1), 0)).toMatchObject({
            accepted: false,
            closeCode: 1009,
        });
        expect(validateClientFrame(new ArrayBuffer(2), MAX_CLIENT_BYTES - 1)).toMatchObject({
            accepted: false,
            closeCode: 1009,
        });
    });

    it('counts UTF-8 bytes rather than JavaScript code units', () => {
        expect(frameByteLength('⚓')).toBe(3);
    });
});
