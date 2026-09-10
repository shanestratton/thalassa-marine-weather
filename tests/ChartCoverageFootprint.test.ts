import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('index.css', 'utf8');
const controls = readFileSync('components/map/ChartDepthControls.tsx', 'utf8');

describe('coverage notice keeps its complete content inside compact map layouts', () => {
    it('lets the Library label wrap instead of forcing the warning into a narrow text column', () => {
        const button = css.match(/\.thalassa-enc-coverage-notice > button\s*\{([^}]+)\}/)?.[1];
        expect(button).toBeDefined();
        expect(button).toContain('inline-size: min-content');
        expect(button).toContain('white-space: normal');
        // Layout may wrap the label, but may not shorten the warning or lose
        // the action's existing accessible name and minimum finger target.
        expect(controls).toContain('No verified ENC charts installed. Library imports are reference-only.');
        expect(controls).toContain('aria-label="Open on-device ENC Library"');
        expect(controls).toMatch(/className="min-h-\[44px\][^\n]+\n\s+aria-label="Open on-device ENC Library"/);
    });

    it('gives narrow-portrait warning text its full row above the action', () => {
        const portrait = css.slice(css.indexOf('@media (orientation: portrait) and (max-width: 360px)'));
        const notice = portrait.match(/\.thalassa-enc-coverage-notice\s*\{([^}]+)\}/)?.[1];
        expect(notice).toContain('flex-direction: column');
        expect(notice).toContain('align-items: stretch');
        expect(notice).toContain('gap: 6px');
        expect(notice).toContain('padding-block: 4px');
        expect(notice).not.toMatch(/(?:font-size|max-height|overflow|line-clamp):/);
    });

    it('uses compact vertical padding for short-landscape notices without changing text size', () => {
        const landscape = css.slice(css.indexOf('@media (orientation: landscape) and (max-height: 600px)'));
        const notice = landscape.match(/\.thalassa-enc-coverage-notice\s*\{([^}]+)\}/)?.[1];
        expect(notice).toContain('padding-block: 4px');
        expect(notice).not.toMatch(/(?:font-size|max-height|overflow|line-clamp):/);
    });
});
