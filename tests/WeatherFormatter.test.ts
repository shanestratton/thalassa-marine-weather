/**
 * WeatherFormatter — precipitation label tests
 */
import { describe, it, expect } from 'vitest';
import { getPrecipitationLabelV2 } from '../services/WeatherFormatter';

describe('WeatherFormatter', () => {
    describe('getPrecipitationLabelV2', () => {
        it('heavy rain > 5mm', () => {
            const result = getPrecipitationLabelV2(null, 8.2);
            expect(result.label).toBe('HEAVY RAIN');
            expect(result.value).toBe('8.2 mm');
        });

        it('showers: 0.5 < rain <= 5', () => {
            const result = getPrecipitationLabelV2(null, 2.5);
            expect(result.label).toBe('SHOWERS');
            expect(result.value).toBe('2.5 mm');
        });

        it('light: 0.15 <= rain <= 0.5', () => {
            const result = getPrecipitationLabelV2(null, 0.3);
            expect(result.label).toBe('LIGHT');
            expect(result.value).toBe('0.3 mm');
        });

        it('dry: rain < 0.15', () => {
            const result = getPrecipitationLabelV2(null, 0.1);
            expect(result.label).toBe('DRY');
            expect(result.value).toBe('0.0 mm');
        });

        it('dry: zero rain', () => {
            const result = getPrecipitationLabelV2(null, 0);
            expect(result.label).toBe('DRY');
            expect(result.value).toBe('0.0 mm');
        });

        it('boundary: exactly 5.0 is SHOWERS', () => {
            const result = getPrecipitationLabelV2(null, 5.0);
            expect(result.label).toBe('SHOWERS');
        });

        it('boundary: exactly 0.5 is LIGHT (> 0.5 required for SHOWERS)', () => {
            const result = getPrecipitationLabelV2(null, 0.5);
            expect(result.label).toBe('LIGHT');
        });

        it('boundary: exactly 0.15 is LIGHT', () => {
            const result = getPrecipitationLabelV2(null, 0.15);
            expect(result.label).toBe('LIGHT');
        });
    });
});
