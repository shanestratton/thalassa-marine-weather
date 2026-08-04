import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANIMATION_BUDGET, startAnimationBudgetGuard, summariseAnimations } from '../utils/animationBudget';

function fakeAnimations(spec: Record<string, number>): Animation[] {
    const out: Animation[] = [];
    for (const [name, count] of Object.entries(spec)) {
        for (let i = 0; i < count; i++) out.push({ animationName: name } as unknown as Animation);
    }
    return out;
}

afterEach(() => {
    vi.useRealTimers();
    document.body.className = '';
});

describe('animationBudget', () => {
    it('names the worst offenders so a crash report identifies the source', () => {
        const summary = summariseAnimations(fakeAnimations({ pulse: 40, ping: 12, spin: 2 }));

        expect(summary.startsWith('pulse×40')).toBe(true);
        expect(summary).toContain('ping×12');
    });

    it('sheds decorative animations over budget and restores them well under it', () => {
        vi.useFakeTimers();
        let live = fakeAnimations({ pulse: ANIMATION_BUDGET + 10 });
        document.getAnimations = (() => live) as typeof document.getAnimations;

        const stop = startAnimationBudgetGuard();
        expect(document.body.classList.contains('animation-diet')).toBe(true);

        // Hysteresis: still above the release line → stays on the diet.
        live = fakeAnimations({ pulse: ANIMATION_BUDGET - 5 });
        vi.advanceTimersByTime(2_500);
        expect(document.body.classList.contains('animation-diet')).toBe(true);

        live = fakeAnimations({ pulse: 4 });
        vi.advanceTimersByTime(2_500);
        expect(document.body.classList.contains('animation-diet')).toBe(false);

        stop();
    });

    it('never measures or repaints while the page is hidden', () => {
        vi.useFakeTimers();
        const getAnimations = vi.fn(() => fakeAnimations({ pulse: ANIMATION_BUDGET + 50 }));
        document.getAnimations = getAnimations as unknown as typeof document.getAnimations;
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

        const stop = startAnimationBudgetGuard();
        vi.advanceTimersByTime(6_000);

        expect(getAnimations).not.toHaveBeenCalled();
        expect(document.body.classList.contains('animation-diet')).toBe(false);

        hidden.mockRestore();
        stop();
    });

    it('no-ops without getAnimations rather than throwing into app bootstrap', () => {
        const original = document.getAnimations;
        // @ts-expect-error — deliberately removing the API under test
        document.getAnimations = undefined;

        expect(() => startAnimationBudgetGuard()()).not.toThrow();

        document.getAnimations = original;
    });
});
