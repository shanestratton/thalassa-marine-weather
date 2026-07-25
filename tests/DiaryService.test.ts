/**
 * DiaryService — Unit tests for diary constants and types.
 */
import { describe, it, expect } from 'vitest';
import {
    DiaryService,
    diaryAudioFileExtension,
    MOOD_CONFIG,
    normalizeDiaryAudioMimeType,
} from '../services/DiaryService';
import type { DiaryMood } from '../services/DiaryService';

describe('MOOD_CONFIG', () => {
    const moods: DiaryMood[] = ['epic', 'good', 'neutral', 'rough', 'storm'];

    it('defines config for all mood types', () => {
        moods.forEach((mood) => {
            expect(MOOD_CONFIG[mood]).toBeDefined();
        });
    });

    it('each mood has emoji, label, and color', () => {
        moods.forEach((mood) => {
            const config = MOOD_CONFIG[mood];
            expect(config.emoji).toBeDefined();
            expect(typeof config.emoji).toBe('string');
            expect(config.label).toBeDefined();
            expect(typeof config.label).toBe('string');
            expect(config.color).toBeDefined();
            expect(typeof config.color).toBe('string');
        });
    });

    it('mood emojis are non-empty', () => {
        moods.forEach((mood) => {
            expect(MOOD_CONFIG[mood].emoji.length).toBeGreaterThan(0);
        });
    });

    it('mood labels are descriptive', () => {
        moods.forEach((mood) => {
            expect(MOOD_CONFIG[mood].label.length).toBeGreaterThan(2);
        });
    });

    it('contains exactly 5 moods', () => {
        expect(Object.keys(MOOD_CONFIG).length).toBe(5);
    });
});

describe('diary audio MIME handling', () => {
    it('strips MediaRecorder codec parameters before transcription', () => {
        expect(normalizeDiaryAudioMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    });

    it('preserves the correct container type and storage extension', () => {
        expect(normalizeDiaryAudioMimeType('audio/mp4; codecs=mp4a.40.2')).toBe('audio/mp4');
        expect(diaryAudioFileExtension('audio/mp4')).toBe('m4a');
        expect(diaryAudioFileExtension('audio/webm;codecs=opus')).toBe('webm');
    });

    it('normalizes common browser aliases', () => {
        expect(normalizeDiaryAudioMimeType('audio/x-wav')).toBe('audio/wav');
        expect(normalizeDiaryAudioMimeType('audio/x-m4a')).toBe('audio/mp4');
    });

    it('prepares a local data URI without creating remote media', async () => {
        const dataUri = await DiaryService.createAudioDataUri(new Blob(['voice memo'], { type: 'audio/webm' }));

        expect(dataUri).toMatch(/^data:audio\/webm;base64,/);
    });
});
