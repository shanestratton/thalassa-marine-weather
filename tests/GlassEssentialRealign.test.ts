/**
 * The stacked half-cards.
 *
 * Shane photographed The Glass on 2026-08-28 showing the lower chrome of one
 * radar card (wind chip, scrubber, RainViewer) directly above the upper
 * chrome of the next (LIVE pill, "300 nm" ring, condition). One card cannot
 * draw both ends and nothing in between, so that is two adjacent day rows,
 * with scrollTop parked at a non-integer multiple of the row height.
 *
 * Why it happens: every day row is `h-full` inside the vertical scroller, so
 * a row-aligned position is exactly k × clientHeight in raw pixels.
 * Collapsing to essential mode makes each row 81px TALLER (glassLayout — the
 * collapsed hero container's `top` sits 163 − 82 px higher) while scrollTop
 * is left untouched. A row-aligned offset becomes fractional on the spot.
 *
 * The one rescue was an ANIMATED `scrollTo({behavior:'smooth'})`, fired 10ms
 * into the container's 300ms `transition-[top]`, on a box the same render had
 * just made overflow-hidden and stripped of scroll-snap. WebKit has no scroll
 * anchoring, so nothing re-snapped, and overflow-hidden meant the skipper
 * could not drag it straight either.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const hero = readFileSync('components/dashboard/Hero.tsx', 'utf8');
const dashboard = readFileSync('components/Dashboard.tsx', 'utf8');
const heroSlide = readFileSync('components/dashboard/HeroSlide.tsx', 'utf8');

describe('vertical day carousel realignment', () => {
    it('resets instantly — an animated scroll must never race an animating height', () => {
        expect(hero).toContain('if (scrollRef.current) scrollRef.current.scrollTop = 0;');
    });

    it('no longer animates the reset', () => {
        const reset = hero.slice(hero.indexOf('const resetVertical'), hero.indexOf('const timeSelectHandlers'));
        expect(reset).not.toContain("behavior: 'smooth'");
    });

    it('realigns on the mode itself, not only on the window event', () => {
        // Not every route into essential mode dispatches one: isExpanded is
        // also derived from locationType, so a refresh that reclassifies the
        // location flips the mode silently.
        expect(hero).toContain('if (!isEssentialMode) return;');
        expect(hero).toContain('}, [isEssentialMode, resetVertical]);');
    });

    it('re-asserts after the 300ms transition, because the rows are still growing', () => {
        expect(hero).toContain('const t = setTimeout(resetVertical, 320);');
        expect(hero).toContain('return () => clearTimeout(t);');
    });

    it('mirrors the realign the horizontal carousel already had', () => {
        // HeroSlide has always owned its own axis this way. The vertical one
        // had only the event, which is the whole asymmetry behind the bug.
        expect(heroSlide).toContain('if (isEssentialMode && horizontalScrollRef.current)');
        expect(heroSlide).toContain('horizontalScrollRef.current.scrollTo({ left: 0 })');
    });

    it('keeps scroll-snap in BOTH modes so any later height change re-resolves', () => {
        // Rotation, or the rain card growing when minutely data lands, would
        // otherwise strand it again. overflow-hidden still suppresses the
        // swipe that essential mode exists to hide.
        expect(hero).toContain("${isEssentialMode ? 'overflow-hidden' : 'overflow-y-auto'} snap-y snap-mandatory");
        expect(hero).not.toContain("'overflow-y-auto snap-y snap-mandatory'");
    });
});

describe('the day the header claims', () => {
    it('clears the refs, not just the state, when collapsing', () => {
        // handleDayChange/handleHourChange/handleActiveDataChange each
        // re-assert setActiveDay(activeDayRef.current) inside a rAF, and the
        // reset provokes one — so state-only clearing let the old day return.
        // The header read MON 31 AUG after a toggle that had just set day 0.
        const block = dashboard.slice(dashboard.indexOf('const goingEssential = isExpanded;'));
        const collapse = block.slice(0, block.indexOf('hero-reset-scroll'));
        expect(collapse).toContain('activeDayRef.current = 0;');
        expect(collapse).toContain('activeHourRef.current = 0;');
        expect(collapse).toContain('activeDayDataRef.current = null;');
    });
});
