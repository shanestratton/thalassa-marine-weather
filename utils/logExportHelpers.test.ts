/**
 * logExportHelpers — Unit tests for PDF export color constants and interfaces.
 */
import { describe, it, expect } from 'vitest';
import { NAVY, GOLD, GRAY, LIGHT_GRAY } from './logExportHelpers';

describe('logExportHelpers constants', () => {
    it('exports NAVY color', () => {
        expect(NAVY).toBe('#1a2a3a');
    });

    it('exports GOLD color', () => {
        expect(GOLD).toBe('#c9a227');
    });

    it('exports GRAY color', () => {
        expect(GRAY).toBe('#6a7a8a');
    });

    it('exports LIGHT_GRAY color', () => {
        expect(LIGHT_GRAY).toBe('#e8eef4');
    });

    it('all colors are valid hex strings', () => {
        [NAVY, GOLD, GRAY, LIGHT_GRAY].forEach((color) => {
            expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        });
    });
});
