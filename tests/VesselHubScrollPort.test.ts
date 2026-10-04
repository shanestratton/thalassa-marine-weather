import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Shane 2026-09-09: "on the vessel page, if you scroll upwards, the diary and
 * the scuttlebutt pages get stuck under the 4 cards above them. it needs to
 * snap back into position if the punter has got nothing else clicked."
 *
 * The root reserves the tab bar once; the inner scroll port must not reserve
 * it again, or a short page gets dead scroll room that parks the first tiles
 * under the fixed deck.
 */
const hub = readFileSync('components/VesselHub.tsx', 'utf8');
const portClass = 'overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 stagger-in';

/** Inspect executable JSX, not the explanatory comments around the port. */
function lowerPortMarkup(): string {
    const source = hub
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const marker = source.indexOf(portClass);
    expect(marker, 'find the lower hub port, not the Boat Binder screen').toBeGreaterThan(-1);
    expect(source.indexOf(portClass, marker + 1), 'the lower hub port is unique').toBe(-1);
    return source.slice(source.lastIndexOf('<div', marker));
}

describe('Vessel page scroll port', () => {
    it('reserves the tab bar on the root only, and the port keeps its overscroll to itself', () => {
        const rootStart = hub.indexOf('className="vessel-hub-surface w-full h-full flex flex-col');
        const portStart = hub.indexOf('overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 stagger-in');
        expect(rootStart).toBeGreaterThan(-1);
        expect(portStart).toBeGreaterThan(rootStart);
        const rootBlock = hub.slice(rootStart, rootStart + 600);
        expect(rootBlock).toContain("paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)'");
        const portBlock = hub.slice(portStart, portStart + 900);
        expect(portBlock).not.toContain('4rem + env(safe-area-inset-bottom)');
        expect(portBlock).toContain("overscrollBehaviorY: 'contain'");
    });

    it('settles near the top without mandatory snapping that could trap lower settings', () => {
        const port = lowerPortMarkup();
        const opening = port.slice(0, port.indexOf('>') + 1);
        expect(opening).toContain("scrollSnapType: 'y proximity'");
        // The pt-2 inset is part of the resting position. Without matching
        // scroll padding, snapping would lift the first row by eight pixels.
        expect(opening).toContain('pt-2');
        expect(opening).toContain("scrollPaddingTop: '0.5rem'");
        expect(opening).toContain('pb-2');
        // The port's pb-2 (the menu box has no margin of its own): the lower
        // resting point is the true bottom, not a second one short of it. It
        // was pb-4 until the page filled its screen (Shane 2026-10-04): with
        // the root's 8 px, the box now ends 16 px off the tab bar.
        expect(opening).toContain("scrollPaddingBottom: '0.5rem'");
        expect(opening).toContain("overscrollBehaviorY: 'contain'");
        expect(opening).not.toContain('mandatory');
    });

    it('anchors home on the first Diary/Scuttlebutt row rather than the fixed deck', () => {
        const port = lowerPortMarkup();
        const children = port.slice(port.indexOf('>') + 1).trimStart();
        const firstOpening = children.slice(0, children.indexOf('>') + 1);
        expect(firstOpening).toMatch(/^<div\s/);
        expect(firstOpening).toContain("scrollSnapAlign: 'start'");

        const nextCard = children.indexOf('<SkipperDeviceControl');
        expect(nextCard).toBeGreaterThan(0);
        const firstRow = children.slice(0, nextCard);
        expect(firstRow).toContain('aria-label="Open Diary"');
        expect(firstRow).toContain('aria-label="Open Scuttlebutt"');
        expect(firstRow.match(/scrollSnapAlign:/g)).toHaveLength(1);
        expect(firstOpening).not.toContain('scrollSnapStop');
    });

    it('rests at the end of the menu box only when the page really scrolls', () => {
        // The page fits one screen (Shane 2026-10-04), so normally there is
        // nothing to snap to. A state that adds height (the fresh-install "Set
        // up your vessel" card) can still make it scroll; then the box's end
        // is a resting point, so a part-way scroll is not pulled back home.
        const port = lowerPortMarkup();
        const box = port.indexOf('data-testid="vessel-hub-menu"');
        expect(box).toBeGreaterThan(0);
        const opening = port.slice(port.lastIndexOf('<div', box), port.indexOf('>', box) + 1);
        expect(opening).toContain("scrollSnapAlign: portRoomy ? 'end' : 'none'");
        expect(hub).toMatch(/const END_REST_MIN_SCROLL = 48;/);
        expect(hub).toContain('setPortRoomy(room >= END_REST_MIN_SCROLL)');
        expect(opening).not.toContain('scrollMarginBottom');
        expect(opening).not.toContain('scrollSnapStop');
        // Nothing on the hub is folded any more.
        expect(port).not.toContain('<SectionHeader');
        expect(port).not.toContain('<CollapsibleContent');
    });

    it('draws the "more below" fade only when there is more below', () => {
        // On a page that fits, a bottom mask would only dim the box's edge.
        expect(hub).toContain(
            "const hubPortFade = portScrolled ? HUB_PORT_FADE_BOTH : portOverflows ? HUB_PORT_FADE_BOTTOM : '';",
        );
        expect(hub).toContain('setPortOverflows(room > 1)');
    });

    it('puts every menu row in the one box, Settings among them, none behind an expand', () => {
        const port = lowerPortMarkup();
        const box = port.indexOf('data-testid="vessel-hub-menu"');
        const order = ['Crew & Float Plan', 'Boat Binder', 'NMEA Gateway', 'Music', 'Settings', 'Boat Network'].map(
            (label) => port.indexOf(`label="${label}"`),
        );
        expect(order[0]).toBeGreaterThan(box);
        for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
        const settings = order[4];
        expect(port.slice(settings, port.indexOf('/>', settings))).toContain("onNavigate('settings')");
    });
});
