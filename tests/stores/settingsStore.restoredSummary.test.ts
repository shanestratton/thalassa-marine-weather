/**
 * Unit tests for buildRestoredSummary — the helper that feeds the
 * welcome-back modal with the user-facing summary of what just got
 * synced from the cloud.
 */

import { describe, it, expect } from 'vitest';
import { buildRestoredSummary, DEFAULT_SETTINGS } from '../../stores/settingsStore';
import type { UserSettings } from '../../types';

describe('buildRestoredSummary', () => {
    it('falls back to a generic greeting when no name set', () => {
        const summary = buildRestoredSummary(DEFAULT_SETTINGS);
        expect(summary.greetingName).toBeNull();
    });

    it('prefers nickname over first name', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            firstName: 'Shane',
            nickname: 'Skipper',
        };
        expect(buildRestoredSummary(s).greetingName).toBe('Skipper');
    });

    it('falls back to firstName when nickname is missing', () => {
        const s: UserSettings = { ...DEFAULT_SETTINGS, firstName: 'Shane' };
        expect(buildRestoredSummary(s).greetingName).toBe('Shane');
    });

    it('builds a sailboat descriptor with length in feet', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            vessel: {
                name: 'Tayana',
                type: 'sail',
                length: 55,
                beam: 17,
                draft: 6,
                displacement: 60000,
                maxWaveHeight: 8,
                cruisingSpeed: 6,
                fuelCapacity: 100,
                waterCapacity: 200,
            },
        };
        const summary = buildRestoredSummary(s);
        expect(summary.vesselName).toBe('Tayana');
        expect(summary.vesselDescriptor).toBe('Sail · 55ft');
    });

    it('classifies units as metric when length=m AND temp=C', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'm', temp: 'C' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('metric');
    });

    it('classifies units as imperial when length=ft AND temp=F', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'ft', temp: 'F' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('imperial');
    });

    it('classifies units as mixed when the user picked one of each', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'm', temp: 'F' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('mixed');
    });

    it('counts only enabled notifications', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            notifications: {
                wind: { enabled: true, threshold: 25 },
                gusts: { enabled: false, threshold: 35 },
                waves: { enabled: true, threshold: 4 },
                swellPeriod: { enabled: false, threshold: 10 },
                visibility: { enabled: false, threshold: 1 },
                uv: { enabled: false, threshold: 8 },
                tempHigh: { enabled: false, threshold: 35 },
                tempLow: { enabled: false, threshold: 5 },
                precipitation: { enabled: true },
            },
        };
        expect(buildRestoredSummary(s).armedNotifications).toBe(3);
    });

    it('counts saved locations exactly', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            savedLocations: ['Newport', 'Sydney', 'Brisbane'],
        };
        expect(buildRestoredSummary(s).savedLocationCount).toBe(3);
    });

    it('treats undefined savedLocations as zero', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            savedLocations: undefined as unknown as string[],
        };
        expect(buildRestoredSummary(s).savedLocationCount).toBe(0);
    });

    it('passes through default location and subscription tier verbatim', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            defaultLocation: 'Magnetic Island',
            subscriptionTier: 'owner',
        };
        const summary = buildRestoredSummary(s);
        expect(summary.defaultLocation).toBe('Magnetic Island');
        expect(summary.subscriptionTier).toBe('owner');
    });

    it('omits vessel descriptor when vessel is empty (no type, no length)', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            vessel: {
                name: 'Unnamed',
                type: undefined as unknown as 'sail',
                length: 0,
                beam: 0,
                draft: 0,
                displacement: 0,
                maxWaveHeight: 0,
                cruisingSpeed: 0,
                fuelCapacity: 0,
                waterCapacity: 0,
            },
        };
        const summary = buildRestoredSummary(s);
        expect(summary.vesselName).toBe('Unnamed');
        expect(summary.vesselDescriptor).toBeNull();
    });
});
