/**
 * DiaryService — Unit tests for diary constants and types.
 */
import { describe, it, expect } from 'vitest';
import { MOOD_CONFIG } from '../services/DiaryService';
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
