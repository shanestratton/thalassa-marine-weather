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

    it('provides a bottom resting position on the expandable Settings group', () => {
        const port = lowerPortMarkup();
        const settingsHeader = port.indexOf('label="Settings & Connect"');
        expect(settingsHeader).toBeGreaterThan(0);
        const groupStart = port.lastIndexOf('<div', settingsHeader);
        const opening = port.slice(groupStart, port.indexOf('>', groupStart) + 1);
        expect(opening).toContain("scrollSnapAlign: 'end'");
        // The existing bottom margin leaves reading room without extending
        // the snap area. Adding another scroll margin would make a tiny
        // collapsed overflow a second resting point just below home.
        expect(opening).toContain('mb-4');
        expect(opening).not.toContain('scrollMarginBottom');
        expect(opening).not.toContain('scrollSnapStop');

        const accountRow = port.indexOf('label="Account & Settings"', settingsHeader);
        expect(accountRow).toBeGreaterThan(settingsHeader);
        const settingsContents = port.slice(settingsHeader, accountRow);
        expect(settingsContents).toContain("<CollapsibleContent open={expanded.has('setup')}>");
        expect(settingsContents).toContain('label="NMEA Gateway"');
        expect(settingsContents).toContain('label="Boat Network"');
        // Put the target around the whole expandable group, not inside its
        // clipped animated content, so it exists in the collapsed state too.
        expect(settingsContents).not.toContain('scrollSnapAlign');
    });
});
