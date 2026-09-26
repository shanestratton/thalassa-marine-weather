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
const portClass = 'overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-4 stagger-in';

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
        const portStart = hub.indexOf('overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-4 stagger-in');
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
        expect(opening).toContain('pb-4');
        expect(opening).toContain("scrollPaddingBottom: '1rem'");
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

    it('provides a bottom resting position on the expandable Connections & music group', () => {
        const port = lowerPortMarkup();
        // "Connections & music" since UX scorecard run 7: Settings left this
        // group for an always-visible row, and Music joined it from its own
        // one-row accordion. The id stays 'setup'.
        const groupHeader = port.indexOf('label="Connections & music"');
        expect(groupHeader).toBeGreaterThan(0);
        const groupStart = port.lastIndexOf('<div', groupHeader);
        const opening = port.slice(groupStart, port.indexOf('>', groupStart) + 1);
        expect(opening).toContain("scrollSnapAlign: 'end'");
        // The existing bottom margin leaves reading room without extending
        // the snap area. Adding another scroll margin would make a tiny
        // collapsed overflow a second resting point just below home.
        expect(opening).toContain('mb-4');
        expect(opening).not.toContain('scrollMarginBottom');
        expect(opening).not.toContain('scrollSnapStop');

        const musicRow = port.indexOf('label="Music"', groupHeader);
        expect(musicRow).toBeGreaterThan(groupHeader);
        const groupContents = port.slice(groupHeader, musicRow);
        expect(groupContents).toContain(
            '<CollapsibleContent open={expanded.has(\'setup\')} id="vessel-hub-connections">',
        );
        expect(groupContents).toContain('controlsId="vessel-hub-connections"');
        expect(groupContents).toContain('label="NMEA Gateway"');
        expect(groupContents).toContain('label="Boat Network"');
        // Put the target around the whole expandable group, not inside its
        // clipped animated content, so it exists in the collapsed state too.
        expect(groupContents).not.toContain('scrollSnapAlign');
        // Only one collapsible group is left on the hub.
        expect(port.match(/<SectionHeader/g)).toHaveLength(1);
    });

    it('shows the Settings row without an expand, beside the Boat Binder', () => {
        // Settings was reachable only by expanding the collapsed group at the
        // foot of the hub, below the fold at 375x667 (UX scorecard run 7,
        // N-vessel-hub-structure).
        const port = lowerPortMarkup();
        const binder = port.indexOf('label="Boat Binder"');
        const settings = port.indexOf('label="Settings"');
        const group = port.indexOf('<SectionHeader');
        expect(binder).toBeGreaterThan(0);
        expect(settings).toBeGreaterThan(binder);
        expect(group).toBeGreaterThan(settings);
        expect(port.slice(binder, settings)).not.toContain('<CollapsibleContent');
        expect(port.slice(settings, port.indexOf('/>', settings))).toContain("onNavigate('settings')");
    });
});
