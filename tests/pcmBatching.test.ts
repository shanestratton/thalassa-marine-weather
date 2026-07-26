import { describe, expect, it } from 'vitest';
import {
    PCM_BATCH_SAFETY_FLUSH_MS,
    PCM_BATCH_TARGET_MS,
    pcmBatchBytesForSampleRate,
} from '../services/voice/pcmBatching';

describe('live PCM batching', () => {
    it('uses a sample-rate-aware batch close to 45 ms', () => {
        expect(pcmBatchBytesForSampleRate(48_000)).toBe(4_320);
        expect(pcmBatchBytesForSampleRate(44_100)).toBe(3_969);
        expect(pcmBatchBytesForSampleRate(16_000)).toBe(1_440);
        expect(PCM_BATCH_TARGET_MS).toBeGreaterThanOrEqual(40);
        expect(PCM_BATCH_TARGET_MS).toBeLessThanOrEqual(50);
    });

    it('keeps the safety flush close behind the normal batch target', () => {
        expect(PCM_BATCH_SAFETY_FLUSH_MS).toBeGreaterThan(PCM_BATCH_TARGET_MS);
        expect(PCM_BATCH_SAFETY_FLUSH_MS).toBeLessThanOrEqual(75);
    });

    it('clamps anomalous context rates to the supported Deepgram range', () => {
        expect(pcmBatchBytesForSampleRate(0)).toBe(720);
        expect(pcmBatchBytesForSampleRate(96_000)).toBe(4_320);
    });
});
