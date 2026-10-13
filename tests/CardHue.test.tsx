/**
 * One card style with a soft coloured hue (128-HUES, Shane 2026-10-13):
 *
 *   "can we put a nice coloured hue around the single log items similar (but
 *    different color) to the passage logs";
 *   "ok the crew and float plan, really needs its own card, can we make a nice
 *    card for it without having to scroll up and down on the page, maybe a
 *    nice hue as well on the back of it" ("sorry that is on the vessel page");
 *   "ok the four big cards in the route plan page, can they have a nice hue
 *    around them also, just for consistency."
 *
 * The treatment is ONE class (styles/card-hue.css) and a colour token per
 * surface. This pins the rules and which card wears which token; the
 * geometry (every menu page still fits one screen) is measured in
 * browser-tests/menu-pages-fit.spec.ts and plan-page-fit.spec.ts, and the
 * Log's cards in passage-log-layout.spec.ts.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

vi.mock('../pages/log/useEndpointNames', () => ({
    useEndpointNames: () => ({ startLabel: 'Ponta Delgada', endLabel: 'Horta' }),
}));
vi.mock('../components/DateGroupedTimeline', () => ({ DateGroupedTimeline: () => null }));
vi.mock('../components/LiveMiniMap', () => ({ LiveMiniMap: () => null }));

import { VoyageCard } from '../pages/log/LogSubComponents';
import { PassageLogList } from '../pages/log/PassageLogList';
import { PLAN_TILE_CLASS, PLAN_TILE_STYLE } from '../components/passage/PlanTile';

const indexCss = readFileSync('index.css', 'utf8');
const read = (path: string) => {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
};
const css = read('styles/card-hue.css');

/** The declarations of the one rule whose selector list is exactly `selector`
 *  (a rule's start: its line follows a closing brace, a comment or the top,
 *  never another selector's trailing comma). */
function rule(selector: string): Record<string, string> {
    const starts: number[] = [];
    for (let at = css.indexOf(`\n${selector} {`); at > -1; at = css.indexOf(`\n${selector} {`, at + 1)) {
        if (!css.slice(0, at).trimEnd().endsWith(',')) starts.push(at);
    }
    expect(starts.length, `rules for ${selector}`).toBe(1);
    const at = starts[0];
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    const out: Record<string, string> = {};
    for (const declaration of body.split(/;\s*(?=[-a-z]+:|$)/)) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        out[declaration.slice(0, colon).trim()] = declaration
            .slice(colon + 1)
            .replace(/\s+/g, ' ')
            .replace(/\( /g, '(')
            .replace(/ \)/g, ')')
            .trim();
    }
    return out;
}

/** What a card wearing `selector` gets: the declarations of every rule whose
 *  selector list names it, merged in source order, as the cascade does for
 *  these one-class selectors. */
function declared(selector: string): Record<string, string> {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Record<string, string> = {};
    let rules = 0;
    for (const [, selectors, body] of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
        rules++;
        for (const declaration of body.split(';')) {
            const colon = declaration.indexOf(':');
            if (colon > -1) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
        }
    }
    expect(rules, `rules naming ${selector}`).toBeGreaterThan(0);
    return out;
}

const voyage = (overrides: Partial<VoyageSummary> = {}): VoyageSummary => ({
    voyageId: 'v-1',
    entryCount: 820,
    startedAt: '2026-09-24T09:10:00Z',
    endedAt: '2026-09-24T11:50:00Z',
    totalDistanceNM: 15.6,
    avgSpeedKts: 5.8,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: 37.74,
    firstLon: -25.66,
    lastLat: 38.53,
    lastLon: -28.63,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 30000,
    ...overrides,
});

const noop = () => {};
function renderCard(summary: VoyageSummary, isSelected = false) {
    render(
        <VoyageCard
            summary={summary}
            entries={[]}
            filteredEntries={[]}
            isSelected={isSelected}
            isExpanded={false}
            suppressMiniMap
            onToggle={noop}
            onSelect={noop}
            onDelete={noop}
            onArchive={noop}
            onShowMap={noop}
            onFollowPlannedRoute={async () => false}
            onDeleteEntry={noop}
            onEditEntry={noop}
        />,
    );
    // The card is the Map button's row; its slot is the swipe wrapper around it.
    const card = screen.getByRole('button', { name: 'View on map' }).parentElement!.parentElement!;
    return { card, slot: card.parentElement! };
}

afterEach(cleanup);

describe('the one card hue', () => {
    it('is one stylesheet, imported once, with an edge, a wash on its back and a halo around it', () => {
        expect(css, 'styles/card-hue.css').not.toBe('');
        expect(indexCss.match(/@import '\.\/styles\/card-hue\.css';/g)).toHaveLength(1);
        const hue = rule('.card-hue');
        expect(hue.border).toBe('1px solid color-mix(in oklab, var(--card-hue) var(--card-hue-edge), transparent)');
        expect(hue['background-image']).toMatch(
            /^linear-gradient\(to bottom, color-mix\(in oklab, var\(--card-hue-wash\)/,
        );
        const halo = rule('.card-hue,\n.card-hue-halo');
        expect(halo['--card-hue-halo']).toBe(
            '0 0 22px -8px color-mix(in oklab, var(--card-hue) var(--card-hue-glow), transparent)',
        );
        expect(halo['box-shadow']).toBe('var(--card-hue-halo)');
        // A shadow and the border the cards already had: nothing moves.
        expect(css).not.toMatch(/\b(margin|padding|height|width|inset|transform)\s*:/);
    });

    it("draws every colour from the app's theme tokens, never a literal", () => {
        const tokens = ['passage', 'sea', 'land', 'crew', 'plan'];
        for (const token of tokens) {
            const declarations = declared(`.card-hue-${token}`);
            expect(declarations['--card-hue'], token).toMatch(/^var\(--color-[a-z]+-\d00\)$/);
            expect(declarations['--card-hue-wash'], token).toMatch(/^var\(--color-[a-z]+-\d00\)$/);
        }
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    });

    it('keeps the passage card exactly the purple it wore', () => {
        expect(rule('.card-hue-passage')).toEqual({
            '--card-hue': 'var(--color-purple-400)',
            '--card-hue-wash': 'var(--color-purple-500)',
            '--card-hue-edge': '40%',
            '--card-hue-glow': '45%',
            '--card-hue-top': '15%',
            '--card-hue-mid': '5%',
            '--card-hue-end': '10%',
        });
    });

    it("gives a standalone voyage its nm chip's sky, quieter than the passage", () => {
        expect(rule('.card-hue-sea')['--card-hue']).toBe('var(--color-sky-400)');
        expect(rule('.card-hue-land')['--card-hue']).toBe('var(--color-emerald-400)');
        const quiet = rule('.card-hue-sea,\n.card-hue-land');
        const passage = rule('.card-hue-passage');
        for (const knob of ['--card-hue-edge', '--card-hue-glow', '--card-hue-top']) {
            expect(parseFloat(quiet[knob]), knob).toBeLessThan(parseFloat(passage[knob]));
        }
    });

    it("gives Crew & Float Plan and the Plan tiles the hub's one accent, sky, under the passage", () => {
        // The Vessel page has one accent (UX scorecard run 7,
        // C-vessel-seven-accents): red / amber / green say state, and a
        // decorative violet Crew card beside them is what that run took
        // away. So the crew card's hue is the hub's sky, no colour of its own,
        // and the Plan page's four tiles wear the same calm sky.
        const passage = declared('.card-hue-passage');
        for (const token of ['crew', 'plan']) {
            const hue = declared(`.card-hue-${token}`);
            expect(hue['--card-hue'], token).toBe('var(--color-sky-400)');
            expect(hue['--card-hue-wash'], token).toBe('var(--color-sky-500)');
            // At or under the passage on every knob: the Log's purple stays
            // the strongest hue in the app.
            for (const knob of [
                '--card-hue-edge',
                '--card-hue-glow',
                '--card-hue-top',
                '--card-hue-mid',
                '--card-hue-end',
            ]) {
                expect(parseFloat(hue[knob]), `${token} ${knob}`).toBeLessThanOrEqual(parseFloat(passage[knob]));
            }
        }
    });
});

describe("the Log's cards", () => {
    it('puts the sea hue on a standalone voyage: its edge and wash on the card, its halo on the slot', () => {
        const { card, slot } = renderCard(voyage());
        expect(card.classList).toContain('card-hue');
        expect(slot.classList).toContain('card-hue-sea');
        expect(slot.classList).toContain('card-hue-halo');
        // Its own plain edge is gone; the white surface stays (daylight remaps it).
        expect(card.className).not.toContain('border-white/6');
        expect(card.className).toContain('bg-white/2');
    });

    it("gives a standalone trip on land its chip's green", () => {
        const { slot } = renderCard(voyage({ landFraction: 1, firstIsOnWater: false }));
        expect(slot.classList).toContain('card-hue-land');
        expect(slot.classList).not.toContain('card-hue-sea');
    });

    it("leaves a passage's legs to the passage's purple, and a plan or an import its own colour", () => {
        for (const summary of [
            voyage({ passageGroupId: 'north' }),
            voyage({ isPlannedRoute: true }),
            voyage({ isImported: true }),
        ]) {
            const { card, slot } = renderCard(summary);
            expect(card.classList).not.toContain('card-hue');
            expect(slot.className).not.toMatch(/card-hue/);
            cleanup();
        }
    });

    it('keeps the sky selection edge on a selected standalone voyage, its halo still on the slot', () => {
        const { card, slot } = renderCard(voyage(), true);
        expect(card.className).toContain('border-sky-400/40');
        expect(card.classList).not.toContain('card-hue');
        expect(slot.classList).toContain('card-hue-halo');
    });

    it('draws the passage group with the same class, in its purple', () => {
        render(
            <PassageLogList
                voyages={[voyage({ voyageId: 'a', passageGroupId: 'north' })]}
                renderVoyage={(v) => <div key={v.voyageId}>{v.voyageId}</div>}
            />,
        );
        const group = screen.getByRole('region', { name: 'Passage · 1 leg' });
        expect(group.classList).toContain('card-hue');
        expect(group.classList).toContain('card-hue-passage');
        expect(group.className).not.toMatch(/border-purple|from-purple|shadow-\[/);
    });
});

describe("the Plan page's four ways in", () => {
    it('wear the plan hue, its edge and halo never overridden by the tile style', () => {
        expect(PLAN_TILE_CLASS.split(' ')).toEqual(expect.arrayContaining(['card-hue', 'card-hue-plan']));
        // The Diary card's fill and blur stay; the edge comes from the class,
        // and the halo stays inline, as the shadow was, so a hover's lift
        // shadow never swaps it out.
        expect(PLAN_TILE_STYLE).not.toHaveProperty('border');
        expect(PLAN_TILE_STYLE.boxShadow).toBe('var(--card-hue-halo)');
        expect(String(PLAN_TILE_STYLE.background)).toContain('--vessel-journal-card-bg');
    });

    it('are all four drawn from PLAN_TILE_CLASS', () => {
        const sources = {
            'Saved routes / Past voyages': read('components/RoutePlanner.tsx'),
            'Trip · Legs': read('components/passage/TripLegPicker.tsx'),
            'Plan Your Day': read('components/dayPlanner/DayPlannerEntry.tsx'),
        };
        for (const [tile, source] of Object.entries(sources)) {
            expect(source, tile).toContain('className={`${PLAN_TILE_CLASS} plan-tile-');
            expect(source, tile).toContain('style={PLAN_TILE_STYLE}');
        }
    });
});
