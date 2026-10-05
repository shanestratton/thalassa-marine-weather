/**
 * Menu pages fit one screen (Shane 2026-10-04: "i would like to ensure that the
 * vessel page all fits on one screen without needing to scroll, as i prefer
 * that all of the menu itemed pages fit into one screen").
 *
 * The geometry itself is measured in browser-tests/menu-pages-fit.spec.ts. This
 * pins the rules that make it fit, so a later edit cannot quietly trade a tap
 * target or a safety word for room: every tier keeps 44 pt rows and buttons,
 * and the shorter safety tiles still hold two lines of state.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('styles/menu-page-fit.css', 'utf8');
const splitCss = readFileSync('styles/split-pane.css', 'utf8');
const indexCss = readFileSync('index.css', 'utf8');
const planCss = readFileSync('styles/plan-page.css', 'utf8');

/** The body of the one block that opens with `prelude`. */
function block(prelude: string, source = css): string {
    const start = source.indexOf(prelude);
    expect(start, `missing block: ${prelude}`).toBeGreaterThan(-1);
    expect(source.indexOf(prelude, start + 1), `ambiguous block: ${prelude}`).toBe(-1);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unclosed block: ${prelude}`);
}

/** A declaration's value inside the rule whose selector is `selector`. */
function value(body: string, selector: string, property: string): string {
    const at = body.indexOf(`${selector} {`);
    expect(at, `missing rule: ${selector}`).toBeGreaterThan(-1);
    const rule = body.slice(at, body.indexOf('}', at));
    const match = rule.match(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`));
    expect(match, `${selector} has no ${property}`).not.toBeNull();
    return match![1].trim();
}

const px = (text: string) => Number(text.replace(/px.*/, ''));

const COMPACT = '@container vessel-hub (max-height: 719.98px)';
const TIGHT = '@container vessel-hub (max-height: 539.98px)';

describe('Vessel page fits one screen', () => {
    it('measures the page it is given, not the screen, so a pane and a phone agree', () => {
        expect(indexCss).toContain("@import './styles/menu-page-fit.css';");
        expect(value(css, '.vessel-hub-surface', 'container')).toBe('vessel-hub / size');
        expect(css).toContain(COMPACT);
        expect(css).toContain(TIGHT);
    });

    it('keeps every row and button at least 44 pt in the tighter tiers', () => {
        const compact = block(COMPACT);
        expect(value(compact, '.vessel-hub-menu .hub-row', 'min-height')).toBe('44px');
        expect(value(compact, '.vessel-hub-tile', 'min-height')).toBe('44px');
        expect(value(compact, '.skipper-device-action', 'height')).toBe('44px');
        // The tight tier only closes gaps: it must not undo a 44 pt floor.
        const tight = block(TIGHT);
        expect(tight).not.toMatch(/min-height:\s*(?:[0-3]?\d|4[0-3])px/);
        expect(tight).not.toContain('.hub-row {');
    });

    it('still gives each safety tile two lines of state, so OVERBOARD wraps, never truncates', () => {
        const name = 11;
        const state = 11 * 2;
        for (const tier of [COMPACT, TIGHT]) {
            const body = block(tier);
            const row = px(value(body, "[data-testid='vessel-safety-controls']", 'grid-auto-rows'));
            const py = px(value(body, '.vessel-safety-tile', 'padding-top')) * 2;
            const gaps = px(value(body, '.vessel-safety-tile', 'gap')) * 2;
            const chip = px(value(body, '.vessel-safety-chip', 'height'));
            const content = py + gaps + chip + name + state;
            expect(row, `${tier}: ${content}px of tile content`).toBeGreaterThanOrEqual(content);
            expect(row).toBeLessThanOrEqual(content + 4);
        }
    });

    it('keeps the cut subtitle the whole description: one line on screen, nothing removed', () => {
        const compact = block(COMPACT);
        expect(value(compact, '.vessel-hub-menu .hub-row-status', 'white-space')).toBe('nowrap');
        expect(value(compact, '.vessel-hub-menu .hub-row-status', 'text-overflow')).toBe('ellipsis');
        expect(css).not.toMatch(/display:\s*none/);
    });

    it('goes two columns in phone landscape, with the tab bar reservation released', () => {
        const landscape = block(
            '@media (orientation: landscape) and (max-height: 499.98px) {\n    .vessel-hub-surface.vessel-hub-home',
        );
        expect(landscape).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);');
        expect(value(landscape, '.vessel-hub-home > .vessel-hub-port', 'display')).toBe('contents');
        expect(value(landscape, '.vessel-hub-home .vessel-hub-menu', 'grid-column')).toBe('2');
        expect(landscape).toContain('padding-bottom: max(0.5rem, env(safe-area-inset-bottom)) !important;');
    });

    it('fades the menu box in rather than raising it, so its entrance cannot add scroll', () => {
        // stagger-in starts each card 8 px low. Chromium kept that first
        // frame's overflow after the page came to rest: at 320x627 the box
        // ended 6 px above the port's end and the page scrolled 2 px.
        expect(value(css, '.vessel-hub-port.stagger-in > .vessel-hub-menu', 'animation-name')).toBe(
            'vessel-hub-menu-in',
        );
        const keyframes = block('@keyframes vessel-hub-menu-in');
        expect(keyframes).toContain('opacity');
        expect(keyframes).not.toContain('transform');
        expect(keyframes).not.toContain('translate');
    });
});

describe('Vessel page fills its screen', () => {
    // Shane 2026-10-04: "make the whole thing take up the enitre page". Fitting
    // left ~170 px of empty page under the menu box on a 390x844 phone.
    it('shares the height left over between the Diary pair and the menu box, shrinking nothing', () => {
        expect(value(css, '.vessel-hub-home .vessel-hub-port', 'display')).toBe('flex');
        expect(value(css, '.vessel-hub-home .vessel-hub-port', 'flex-direction')).toBe('column');
        // A screen with no height to spare scrolls rather than squeezes.
        expect(value(css, '.vessel-hub-home .vessel-hub-port > *', 'flex-shrink')).toBe('0');
        expect(value(css, '.vessel-hub-home .vessel-hub-journal', 'flex')).toBe('1 0 3.75rem');
        expect(value(css, '.vessel-hub-home .vessel-hub-menu', 'flex-grow')).toBe('1');
        expect(value(css, '.vessel-hub-home .vessel-hub-menu > .hub-row', 'flex')).toBe('1 0 auto');
    });

    it('keeps the Diary pair a 44 pt card at its floor, and stacks it only when it is tall', () => {
        // The pair is a size container: its height is its floor plus its share.
        expect(value(css, '.vessel-hub-home .vessel-hub-journal', 'container')).toBe('vessel-journal / size');
        const compact = block(COMPACT);
        expect(value(compact, '.vessel-hub-home .vessel-hub-journal', 'min-height')).toBe('44px');
        expect(value(compact, '.vessel-hub-home .vessel-hub-journal', 'flex-basis')).toBe('44px');
        const stacked = block('@container vessel-journal (min-height: 86px)');
        expect(value(stacked, '.vessel-hub-journal .vessel-hub-tile', 'flex-direction')).toBe('column');
        // The arrow and the faint glyph are hidden, never removed, on a short card.
        expect(value(css, '.vessel-hub-tile-watermark', 'visibility')).toBe('hidden');
        expect(stacked).toContain('visibility: visible;');
        const card = readFileSync('components/vesselHub/JournalCard.tsx', 'utf8');
        for (const hook of [
            'vessel-hub-tile ',
            'vessel-hub-tile-icon',
            'vessel-hub-tile-text',
            'vessel-hub-tile-title',
            'vessel-hub-tile-watermark',
            'vessel-hub-tile-go',
        ]) {
            expect(card).toContain(hook);
        }
    });
});

describe('Settings menu fits one screen', () => {
    it('is a size container whose rows keep 44 pt with one-line descriptions', () => {
        expect(value(css, '.settings-menu-screen', 'container')).toBe('settings-menu / size');
        const compact = block('@container settings-menu (max-height: 699.98px)');
        expect(value(compact, '.settings-menu-row', 'min-height')).toBe('44px');
        expect(value(compact, '.settings-menu-desc', 'white-space')).toBe('nowrap');
        const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
        for (const hook of ['settings-menu-screen', 'settings-menu-list', 'settings-menu-row', 'settings-menu-desc']) {
            expect(settings).toContain(hook);
        }
    });

    it('drops the 80 px now-playing run-off before the rows tighten, so a 16 Pro Max does not scroll empty space', () => {
        // A 16 Pro Max's menu is ~715-740 px: full rows fit, the run-off under
        // them did not (26 px of scroll with nothing to show).
        const runOff = block('@container settings-menu (max-height: 759.98px)');
        expect(value(runOff, '.settings-menu-list', 'padding-bottom')).toBe('1rem');
        expect(runOff).not.toContain('.settings-menu-row');
        expect(block('@container settings-menu (max-height: 699.98px)')).not.toContain('padding-bottom: 1rem');
    });
});

describe('Split panes', () => {
    it("pins the Route Planner's slide the iPhone's 8 pt above the pane's edge", () => {
        expect(value(splitCss, "[data-split-pane='page'] .route-planner-cta", 'padding-bottom')).toBe('8px !important');
        // The front door ends at the pane's edge, not the overhang below it, so
        // its tiles stop above the slide there too (styles/plan-page.css).
        expect(value(planCss, '.route-planner-page.plan-front-door', 'height')).toContain(
            'var(--split-page-overhang, calc(4rem + env(safe-area-inset-bottom)))',
        );
        // The short-pane card rules went with the cards (2026-10-05).
        expect(splitCss).not.toContain('route-door');
    });

    it("sets the Log's slide and Stop row 8 pt above the pane's edge, and the tab bar's on a phone", () => {
        const clearance = readFileSync('pages/log/footerClearance.ts', 'utf8');
        expect(clearance).toContain(
            "'calc(var(--split-page-overhang, calc(4rem + env(safe-area-inset-bottom))) + 8px)'",
        );
        for (const file of ['pages/log/StartTrackingFooter.tsx', 'pages/log/TrackingFooterControls.tsx']) {
            const footer = readFileSync(file, 'utf8');
            expect(footer).toContain('style={{ paddingBottom: LOG_FOOTER_CLEARANCE }}');
            expect(footer).not.toContain('4rem + env(safe-area-inset-bottom) + 8px');
        }
    });
});

describe('Plan page fits and fills its screen', () => {
    // Shane 2026-10-05: "all fitting on one page, organised, popping". The
    // geometry is measured in browser-tests/plan-page-fit.spec.ts.
    const PLAN_COMPACT = '@container plan-page (max-height: 559.98px)';

    it('measures the page it is given, which ends at the tab bar or the pane edge', () => {
        expect(indexCss).toContain("@import './styles/plan-page.css';");
        expect(value(planCss, '.route-planner-page.plan-front-door', 'container')).toBe('plan-page / size');
        expect(value(planCss, '.route-planner-page.plan-front-door', 'height')).toBe(
            'calc(100% - var(--split-page-overhang, calc(4rem + env(safe-area-inset-bottom))))',
        );
        // The column keeps the CTA's band (8 + the bar + 8) clear, and the
        // keyboard's height while it is up.
        expect(value(planCss, '.plan-front-door .route-planner-form', 'padding-bottom')).toBe(
            'calc(8px + max(3.5rem, 56px) + 8px + var(--plan-kb, 0px))',
        );
        expect(planCss).toContain(PLAN_COMPACT);
        const planner = readFileSync('components/RoutePlanner.tsx', 'utf8');
        expect(planner).toContain("frontDoorInBand ? 'plan-front-door' : 'flex-1'");
        expect(planner).toContain("'--plan-kb': `${keyboardHeight}px`");
    });

    it('keeps every tile a 44 pt target, and a note takes height from the tiles, not the page', () => {
        expect(value(planCss, '.plan-doors-fill', 'grid-template-rows')).toBe('repeat(2, minmax(44px, 1fr))');
        expect(value(planCss, '.plan-doors-fill > .plan-tile', 'container-type')).toBe('size');
        expect(value(planCss, '.plan-doors-fill > .plan-tile', 'min-height')).toBe('44px');
        expect(value(planCss, '.plan-doors-note', 'grid-column')).toBe('1 / -1');
        // Embedded, or under a route summary, a tile is an ordinary 56 px row.
        expect(value(planCss, '.plan-tile', 'min-height')).toBe('56px');
    });

    it('keeps the eyebrow naming the tiles for VoiceOver when it is not drawn', () => {
        const compact = block(PLAN_COMPACT, planCss);
        expect(value(compact, '.plan-front-door .plan-eyebrow', 'clip-path')).toBe('inset(50%)');
        expect(compact).not.toContain('display: none');
    });

    it('makes the hour and the minutes fill their 44 px pill, border included', () => {
        expect(value(planCss, '.plan-depart-time > div', 'align-self')).toBe('stretch');
        expect(value(planCss, '.plan-depart-time > div', 'margin')).toBe('-1px');
        expect(value(planCss, '.plan-depart-time select', 'align-self')).toBe('stretch');
        expect(value(planCss, '.plan-depart-time select', 'min-width')).toBe('44px');
        const control = readFileSync('components/passage/DepartControl.tsx', 'utf8');
        expect(control).toContain('plan-depart-time flex h-11');
        expect(control).not.toMatch(/selectClassName="[^"]*h-full/);
    });

    it('goes two columns in phone landscape, the card beside the tiles, on its own mechanics', () => {
        const landscape = block('@media (orientation: landscape) and (max-height: 500px)', planCss);
        expect(value(landscape, '.route-planner-page.plan-front-door', 'container-type')).toBe('normal');
        expect(value(landscape, '.route-planner-page.plan-front-door', 'height')).toBe('auto');
        expect(value(landscape, '.plan-doors-fill', 'flex')).toBe('none');
        expect(value(landscape, '.plan-front-door .plan-column', 'display')).toBe('grid');
        expect(value(landscape, '.plan-front-door .plan-launch', 'grid-column')).toBe('1');
        expect(value(landscape, '.plan-front-door .plan-doors', 'grid-column')).toBe('2');
    });
});
