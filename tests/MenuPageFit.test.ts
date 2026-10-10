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
/** A value on one line, however the formatter broke it. */
const flat = (text: string) => text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');

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
        // The menu rows are 44 pt at every height since 2026-10-09 (below).
        expect(value(css, '.vessel-hub-menu .hub-row', 'min-height')).toBe('44px');
        expect(compact).not.toContain('.vessel-hub-menu .hub-row {');
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

describe('Boat Binder and Settings fill their screen, with bigger words', () => {
    // Shane 2026-10-09, with a screenshot of the Binder on his phone: "i think
    // the words can be bigger also and take up the whole screen claude. same
    // goes for the settings main page". The geometry is measured in
    // browser-tests/menu-pages-fit.spec.ts; this pins the rules that do it.
    const ROOMY_HUB = '@container vessel-hub (min-height: 580px)';
    const ROOMY_SETTINGS = '@container settings-menu (min-height: 580px)';

    it("fills the Binder the Vessel page's way: a flex column whose cards share the height by their rows", () => {
        expect(value(css, '.vessel-binder-port', 'display')).toBe('flex');
        expect(value(css, '.vessel-binder-port', 'flex-direction')).toBe('column');
        expect(value(css, '.vessel-binder-port > *', 'flex-shrink')).toBe('0');
        expect(value(css, '.vessel-binder-port > .vessel-hub-menu', 'flex')).toBe('1 0 auto');
        expect(value(css, '.vessel-binder-port .vessel-hub-menu > .hub-row', 'flex')).toBe('1 0 auto');
        // Each card grows by its row count, so a row in the four-row card gets
        // the same share as one in the five-row card.
        for (const rows of [2, 3, 4, 5, 6]) {
            expect(css).toMatch(new RegExp(`:has\\(button:nth-of-type\\(${rows}\\)\\) \\{\\s*flex-grow: ${rows};`));
        }
        // It ends where the Vessel page's menu box does: the root's 8 px and 0.5rem.
        expect(value(css, '.vessel-binder-port', 'padding-bottom')).toBe('0.5rem');
    });

    it('fills the full Settings menu only, never a search result', () => {
        expect(value(css, '.settings-menu-fill', 'display')).toBe('flex');
        expect(value(css, '.settings-menu-fill', 'min-height')).toBe('100%');
        expect(value(css, '.settings-menu-fill > .settings-menu-group', 'flex')).toBe('1 0 auto');
        expect(value(css, '.settings-menu-fill .settings-menu-row', 'flex')).toBe('1 0 auto');
        expect(value(css, '.settings-menu-fill .settings-menu-row', 'min-height')).toBe('44px');
        // The 80 px now-playing run-off goes when the menu fills (the pill drags).
        expect(value(css, '.settings-menu-fill', 'padding-bottom')).toBe('1rem');
        // A plain .settings-menu-row rule would stretch a search's rows too.
        expect(css).not.toMatch(/^\s*\.settings-menu-row \{[^}]*flex:/m);
        const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
        expect(settings).toContain("searchIsActive ? '' : ' settings-menu-fill'");
    });

    it('keeps every hub row a 44 pt target at every height, its share of the page as its spacing', () => {
        expect(value(css, '.vessel-hub-menu .hub-row', 'min-height')).toBe('44px');
        expect(value(css, '.vessel-hub-menu .hub-row', 'padding-top')).toBe('0.25rem');
        expect(value(css, '.vessel-hub-menu .hub-row', 'padding-bottom')).toBe('0.25rem');
    });

    it('grows the words from the room the page has, floored at today and capped', () => {
        // The room is how far the page is past ~580 px, where today's rows
        // just fit with a little to spare: none on an SE, so it is unchanged.
        expect(value(css, '.vessel-hub-surface', '--menu-room')).toBe('calc(100cqh - 580px)');
        expect(value(css, '.settings-menu-screen', '--menu-room')).toBe('calc(100cqh - 580px)');
        const title = value(css, '.vessel-hub-menu .hub-row-label', 'font-size');
        expect(title).toMatch(
            /^clamp\(13px, min\(13px \+ 0\.04 \* var\(--menu-room\), var\(--menu-title-wide\)\), 19px\)$/,
        );
        // Since 126-14 the size is a property on the row, so the title line's
        // clip (below) can be measured in it; the title still reads today's clamp.
        expect(value(css, '.settings-menu-row .settings-menu-title', 'font-size')).toBe('var(--settings-title-size)');
        const settingsTitle = css.match(/^\.settings-menu-row \{\s*--settings-title-size:\s*([^;]+);/m)?.[1];
        expect(settingsTitle).toMatch(
            /^clamp\(0\.875rem, min\(13px \+ 0\.04 \* var\(--menu-room\), var\(--menu-title-wide\)\), 19px\)$/,
        );
        // The subtitle: today's text-xs, half the title's rate, 15 px; the
        // Vessel page also caps it by its width (a second line there would
        // come out of the Diary pair's height).
        const floor = 'max(0.75rem, var(--text-micro))';
        const grown = `${floor} + 0.02 * var(--menu-room)`;
        expect(flat(value(css, '.vessel-hub-menu .hub-row-status', 'font-size'))).toBe(
            `clamp(${floor}, min(${grown}, var(--menu-subtitle-wide, 15px)), 15px)`,
        );
        expect(flat(value(css, '.settings-menu-row .settings-menu-desc', 'font-size'))).toBe(
            `clamp(${floor}, ${grown}, 15px)`,
        );
        // A live value beside a title ("Not connected", "Needs sign-in")
        // keeps its size: the title needs the width.
        expect(css).not.toContain('hub-row-value');
        expect(css).not.toContain('settings-menu-status');
        // The icon grows about a third, to the Settings tile's 2.25rem.
        expect(value(css, '.vessel-hub-menu .hub-row-icon svg', 'width')).toMatch(/^clamp\(1rem, .*, 1\.35rem\)$/);
        const bigger = css.slice(css.indexOf('BIGGER WORDS WHERE THERE IS ROOM'));
        expect(value(bigger, '.vessel-hub-menu .hub-row-icon', 'padding')).toMatch(/, 0\.45rem\)$/);
        // A title never runs past its row: each page caps it by its own width.
        for (const page of ['.vessel-hub-binder', '.vessel-hub-home', '.settings-menu-screen']) {
            expect(value(css, page, '--menu-title-wide')).toMatch(/^calc\(\(100cqw - .+\) \/ \d+(\.\d+)?\)$/);
        }
        expect(value(css, '.vessel-hub-home', '--menu-subtitle-wide')).toMatch(
            /^calc\(\(100cqw - .+\) \/ \d+(\.\d+)?\)$/,
        );
    });

    it('lets a subtitle wrap only where there is room; a short screen keeps its one line', () => {
        // The Binder's; the Vessel page keeps its tiers' rule, its room being
        // shared with the Diary pair.
        const roomy = block(ROOMY_HUB);
        expect(value(roomy, '.vessel-hub-binder .hub-row-status', 'white-space')).toBe('normal');
        expect(roomy).not.toContain('.vessel-hub-home');
        const roomySettings = block(ROOMY_SETTINGS);
        expect(value(roomySettings, '.settings-menu-row .settings-menu-desc', 'white-space')).toBe('normal');
        // A live state that no longer fits beside its title goes under it, whole.
        expect(value(roomySettings, '.settings-menu-row .settings-menu-line', 'flex-wrap')).toBe('wrap');
        // The short tiers still hold the line (see the fit tests above).
        expect(value(block(COMPACT), '.vessel-hub-menu .hub-row-status', 'white-space')).toBe('nowrap');
        expect(
            value(block('@container settings-menu (max-height: 699.98px)'), '.settings-menu-desc', 'white-space'),
        ).toBe('nowrap');
    });

    it("keeps a Settings state that drops under its title in the right-hand column, its siblings' side", () => {
        // Review 2026-10-09: dropped to the left, a grey state over the grey
        // description read as one long subtitle, and one card mixed two layouts.
        const roomySettings = block(ROOMY_SETTINGS);
        expect(value(roomySettings, '.settings-menu-line .settings-menu-state', 'margin-left')).toBe('auto');
        // Its size is still the one it has today (above): only its place moves.
        expect(roomySettings).not.toMatch(/settings-menu-state \{[^}]*font-size/);
        // And a wrapped description or Binder subtitle does not leave one word
        // alone on its last line ("... see your / voyage").
        expect(value(roomySettings, '.settings-menu-row .settings-menu-desc', 'text-wrap')).toBe('pretty');
        expect(value(block(ROOMY_HUB), '.vessel-hub-binder .hub-row-status', 'text-wrap')).toBe('pretty');
    });

    // Build 126 (126-14): a fixed state word ("Sign in", "Off", "3 alerts on")
    // sits whole on its title's line or not at all. Its line wraps, and is
    // clipped to one title line, so a word that does not fit beside the title
    // goes to a second line nobody sees (only on a 320 pt phone), never "Ne…".
    // VoiceOver still hears it: it is in the row's name.
    it('keeps a fixed state word whole on the title line, or off it entirely, never cut', () => {
        const line = '.settings-menu-row .settings-menu-line--word';
        expect(value(css, line, 'flex-wrap')).toBe('wrap');
        expect(value(css, line, 'overflow')).toBe('hidden');
        const clip = value(css, line, 'max-height');
        expect(clip).toMatch(/^calc\(var\(--settings-title-size\) \* 1\.43 \+ 2px\)$/);
        // A word that wraps starts below the clip's 2 px allowance, so none of it shows.
        expect(parseFloat(value(css, line, 'row-gap'))).toBeGreaterThan(2 / 16);
        // The word itself never shrinks, wraps or ellipsises.
        const word = '.settings-menu-line--word .settings-menu-state--word';
        expect(value(css, word, 'flex-shrink')).toBe('0');
        expect(value(css, word, 'white-space')).toBe('nowrap');
        expect(css).not.toMatch(/settings-menu-state--word[^{]*\{[^}]*(text-overflow|ellipsis)/);
        // And the roomy tier's wrap still drops a free state (a port, a boat
        // name) under its title, whole.
        expect(value(block(ROOMY_SETTINGS), '.settings-menu-row .settings-menu-line', 'flex-wrap')).toBe('wrap');
        const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
        expect(settings).toContain('settings-menu-state--word');
        expect(settings).toContain('settings-menu-line--word');
        // The word's class list is never the free state's truncating one.
        expect(settings).not.toMatch(/settings-menu-state--word[^'"`]*truncate/);
    });

    it("holds a fresh install's Vessel page at today's words while its setup card makes it scroll", () => {
        // Review 2026-10-09: the rows get no share of the height there, so
        // grown words only made the page scroll further (+37 px at 430x856).
        expect(value(css, '.vessel-hub-home:has(.vessel-hub-setup)', '--menu-room')).toBe('0px');
        const hub = readFileSync('components/VesselHub.tsx', 'utf8');
        expect(hub).toMatch(/className="vessel-hub-setup /);
    });

    it('gives the rows the hooks the rules read', () => {
        const rows = readFileSync('components/vesselHub/listRows.tsx', 'utf8');
        for (const hook of ['hub-row-badge', 'hub-row-chevron']) expect(rows).toContain(hook);
        const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
        for (const hook of [
            'settings-menu-group',
            'settings-menu-line',
            'settings-menu-title',
            'settings-menu-state',
        ]) {
            expect(settings).toContain(hook);
        }
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
