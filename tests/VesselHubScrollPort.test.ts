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
});
