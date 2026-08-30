import { describe, expect, it } from 'vitest';

import { __testing } from '../services/floatPlanPdf';
import type { FloatPlanInput } from '../services/floatPlan';

const { buildHtml } = __testing;

const NOW = 1788000000000;

function plan(overrides: Partial<FloatPlanInput> = {}): FloatPlanInput {
    return {
        vessel: { name: 'Serene Summer', type: 'sail', length: 16.7 },
        route: { name: 'Newport to Mooloolaba', from: 'Newport, QLD', to: 'Mooloolaba', waypoints: [] },
        departureMs: NOW,
        etaMs: NOW + 8 * 3600e3,
        overdueMs: NOW + 12 * 3600e3,
        personsOnBoard: 2,
        whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
        contactAboard: 'Sat phone +881 6234 5678',
        timeZone: 'Australia/Brisbane',
        ...overrides,
    } as FloatPlanInput;
}

describe('float plan PDF', () => {
    it('carries the overdue time and the number to ring', () => {
        // These two are the entire reason a float plan exists. Everything else is
        // reference; without either of them the document is decoration.
        const { html } = buildHtml(plan());
        expect(html).toMatch(/If there is no contact by/i);
        expect(html).toContain('Marine Rescue Redcliffe');
        expect(html).toContain('07 3203 5522');
    });

    it('carries the overdue guide, not just the data', () => {
        // A plan that ships the facts and drops the guide is prettier and worse:
        // it leaves the holder informed and with no idea what to do at 2am.
        const { html } = buildHtml(plan());
        expect(html).toMatch(/IF WE ARE OVERDUE/i);
        expect(html).toMatch(/Try us first/i);
        expect(html).toMatch(/say you do not know/i);
    });

    it('says not to file the plan with a rescue authority', () => {
        // Genuinely counter-intuitive, and the paper form is emphatic about it:
        // the plan goes to a person, not an agency.
        const { html } = buildHtml(plan());
        expect(html).toMatch(/Do not file this plan with a rescue authority/i);
    });

    it('does not let a vessel name inject markup', () => {
        // The name is free text a skipper typed. Rendered unescaped, one stray
        // angle bracket silently eats the rest of the document.
        const { html } = buildHtml(plan({ vessel: { name: 'Sea <b>Dog</b> & "Co"', type: 'sail' } }));
        expect(html).not.toContain('<b>Dog</b>');
        expect(html).toContain('Sea &lt;b&gt;Dog&lt;/b&gt; &amp; &quot;Co&quot;');
    });

    it('produces a filesystem-safe filename, and never an empty one', () => {
        const { filename } = buildHtml(plan({ vessel: { name: 'Sea/Dog: "Winner" *2*', type: 'sail' } }));
        expect(filename).not.toMatch(/[/:*"<>|]/);
        expect(filename.length).toBeGreaterThan(0);

        const fallback = buildHtml(plan({ vessel: { name: '///', type: 'sail' } }));
        expect(fallback.filename.length).toBeGreaterThan(0);
    });
});
