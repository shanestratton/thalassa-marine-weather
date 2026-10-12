import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('index.css', 'utf8');
const controls = readFileSync('components/map/ChartDepthControls.tsx', 'utf8');

describe('coverage notice keeps its complete content inside compact map layouts', () => {
    it('keeps the warning whole: one sentence from the helper, and no Library button (127-C-c)', () => {
        // The ENC Library is retired (Shane's Q1 "yes"), so the notice is its
        // sentence alone: where her licensed charts are, or the open-chart words.
        expect(controls).not.toContain('aria-label="Open on-device ENC Library"');
        expect(controls).not.toContain('Library imports are reference-only');
        expect(controls).toContain('boatChartsLine(');
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
