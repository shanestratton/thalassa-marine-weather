/**
 * The Ship's Log empty state wears the Thalassa mark as a watermark
 * (Shane 2026-09-06: "the thalassa icon in a watermark look. do it big").
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'pages/log/VoyageListPlaceholders.tsx'), 'utf8');

describe('Ship’s Log watermark', () => {
    it('is the Thalassa icon, big, faint, and invisible to screen readers', () => {
        const empty = source.slice(source.indexOf('export const VoyageListEmptyState'));
        expect(empty).toContain('src="/thalassa-icon.png"');
        expect(empty).toContain('w-[380px]');
        expect(empty).toContain('opacity-[0.16] mix-blend-lighten');
        expect(empty).toContain('aria-hidden="true"');
        expect(empty).toContain('radial-gradient(circle at 50% 50%, black 52%, transparent 76%)');
        expect(empty).not.toContain('Compass rose petals');
        // The words the page test looks for are untouched.
        expect(empty).toContain('Begin Your Log');
    });
});
