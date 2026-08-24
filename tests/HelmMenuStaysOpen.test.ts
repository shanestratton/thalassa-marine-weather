/**
 * The layer menu stays open until the punter dismisses it
 * (Shane 2026-08-24: "leave the layer fab open until the punter clicks away
 * from the menu or clicks the layer fab itself").
 *
 * Closing on selection was right while the Sky layers were mutually
 * exclusive — one tap WAS the whole interaction. They stopped being exclusive
 * the same day, so building a wind + rain + pressure view meant reopening the
 * menu and re-entering the category for every single layer. The two changes
 * only make sense together.
 *
 * What may still close it: the FAB, the click-away scrim, Escape, the MOB
 * button (which leaves for an emergency screen), and any item that explicitly
 * declares `dismissOnSelect`. That last one is for full-screen TAKEOVERS
 * rather than overlays — the storm view locks the camera on a cyclone and
 * fills the map, so the menu rolls up behind it (Shane 2026-08-24).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/map/RadialHelmMenu.tsx', 'utf8');

/** Every closeMenu() call with a little context, comments stripped. */
function closeSites(): string[] {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...code.matchAll(/closeMenu\(\)?/g)].map((m) => code.slice(Math.max(0, m.index! - 420), m.index!));
}

describe('the helm menu dismissal contract', () => {
    it('closes on tap ONLY for an item that asks to dismiss', () => {
        const tap = src
            .slice(src.indexOf('const handleItemTap'), src.indexOf('useEffect(() => {', src.indexOf('const handleItemTap')))
            .replace(/\/\/[^\n]*/g, '');
        expect(tap).toContain('toggleLayer(item.layerKey)');
        // Every close in this handler must be behind the opt-in flag.
        for (const m of tap.matchAll(/closeMenu\(\)/g)) {
            expect(tap.slice(Math.max(0, m.index! - 60), m.index!)).toContain('item.dismissOnSelect');
        }
    });

    it('closes on drag-release ONLY for an item that asks to dismiss', () => {
        // The long-press + drag gesture selects on release. It used to close
        // unconditionally, which made the gesture single-shot.
        const up = src
            .slice(src.indexOf('if (isDragging) {'), src.indexOf('dragStartPos.current = null;'))
            .replace(/\/\/[^\n]*/g, '');
        expect(up).toContain('toggleLayer(item.layerKey)');
        for (const m of up.matchAll(/closeMenu\(\)/g)) {
            expect(up.slice(Math.max(0, m.index! - 60), m.index!)).toContain('dismissOnSelect');
        }
    });

    it('reserves dismissOnSelect for takeovers — today, just Storms', () => {
        // If this grows, it should grow deliberately: every entry here is a
        // page that replaces the chart rather than drawing over it.
        const declared = [...src.matchAll(/dismissOnSelect: true/g)];
        expect(declared).toHaveLength(1);
        const storms = src.slice(src.indexOf("id: 'cyclones'"), src.indexOf("id: 'ais'"));
        expect(storms).toContain('dismissOnSelect: true');
    });

    it('does not close on Clear All — clearing is usually a prelude to picking', () => {
        const clears = [...src.matchAll(/Clear All/g)];
        expect(clears.length).toBeGreaterThan(0);
        for (const m of clears) {
            const handler = src.slice(Math.max(0, m.index! - 900), m.index!).replace(/\/\/[^\n]*/g, '');
            expect(handler).not.toContain('closeMenu');
        }
    });

    it('still closes on the FAB, the scrim, Escape and MOB — and nothing else', () => {
        const sites = closeSites();
        // One per dismissal route, plus closeMenu's own declaration.
        for (const before of sites) {
            const legit =
                /const closeMenu = useCallback\($/.test(before.trimEnd()) ||
                before.includes('if (isOpen)') || // FAB tap
                before.includes("event.key === 'Escape'") ||
                before.includes('onClick={() =>') || // scrim
                before.includes('Man Overboard') ||
                before.includes('onOpenMob') ||
                before.includes('restoreFocus') ||
                before.includes('dismissOnSelect') || // opted-in takeover item
                before.includes('[activeCategory, closeMenu, isOpen]'); // keydown deps
            expect(legit, `unexpected closeMenu site: ...${before.slice(-140)}`).toBe(true);
        }
    });

    it('keeps the click-away scrim covering the whole screen while open', () => {
        // Click-away is now one of only four ways out, so the scrim has to be
        // there for the entire open state — not just while a category panel is.
        const scrim = src.slice(src.indexOf('Scrim (click-away to close)'), src.indexOf('Tier 2: Layer Items'));
        expect(scrim).toContain('{isOpen && (');
        expect(scrim).toContain('fixed inset-0');
        expect(scrim).toContain('onClick={() => closeMenu()}');
    });
});
