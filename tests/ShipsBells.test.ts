/**
 * The bells have to be right, because a sailor reading them knows.
 */
import { describe, expect, it } from 'vitest';
import { bellPattern, bellsAt, bellsSpoken, nextBellFrom, watchAt } from '../utils/shipsBells';

describe("ship's bells", () => {
    it('counts one more bell every half hour through a watch', () => {
        // Morning watch, 0400–0800.
        expect(bellsAt(4, 30)).toBe(1);
        expect(bellsAt(5, 0)).toBe(2);
        expect(bellsAt(5, 30)).toBe(3);
        expect(bellsAt(6, 0)).toBe(4);
        expect(bellsAt(7, 30)).toBe(7);
        expect(bellsAt(8, 0)).toBe(8); // eight bells ends it
    });

    it('starts again at the top of the next watch, never at zero', () => {
        expect(bellsAt(0, 0)).toBe(8); // midnight IS eight bells
        expect(bellsAt(0, 30)).toBe(1);
        expect(bellsAt(12, 0)).toBe(8);
        expect(bellsAt(12, 30)).toBe(1);
    });

    it('splits 1600–2000 into the two dog watches', () => {
        expect(watchAt(16, 30).name).toBe('First Dog Watch');
        expect(watchAt(17, 59).name).toBe('First Dog Watch');
        expect(watchAt(18, 0).name).toBe('Last Dog Watch');
        expect(watchAt(19, 59).name).toBe('Last Dog Watch');
        expect(watchAt(20, 0).name).toBe('First Watch');
    });

    it('ends the last dog watch on EIGHT bells, not four', () => {
        // The mistake every naive implementation makes: the last dog watch
        // closes the day's rotation, so 2000 is eight bells.
        expect(bellsAt(16, 30)).toBe(1);
        expect(bellsAt(17, 30)).toBe(3);
        expect(bellsAt(18, 0)).toBe(8); // first dog watch ended
        expect(bellsAt(18, 30)).toBe(1);
        expect(bellsAt(19, 30)).toBe(3);
        expect(bellsAt(20, 0)).toBe(8); // and so does the last
    });

    it('names every watch across the whole day', () => {
        expect(watchAt(0, 0).name).toBe('Middle Watch');
        expect(watchAt(3, 59).name).toBe('Middle Watch');
        expect(watchAt(4, 0).name).toBe('Morning Watch');
        expect(watchAt(8, 0).name).toBe('Forenoon Watch');
        expect(watchAt(12, 0).name).toBe('Afternoon Watch');
        expect(watchAt(23, 59).name).toBe('First Watch');
    });

    it('strikes in pairs, with the odd one last', () => {
        expect(bellPattern(1)).toEqual([1]);
        expect(bellPattern(2)).toEqual([2]);
        expect(bellPattern(5)).toEqual([2, 2, 1]);
        expect(bellPattern(8)).toEqual([2, 2, 2, 2]);
        // Every pattern sums to the count it describes.
        for (let n = 1; n <= 8; n++) expect(bellPattern(n).reduce((a, b) => a + b, 0)).toBe(n);
    });

    it('finds the next half hour, to the second', () => {
        expect(nextBellFrom(new Date(2026, 8, 3, 4, 12, 44)).toISOString()).toBe(
            new Date(2026, 8, 3, 4, 30, 0, 0).toISOString(),
        );
        expect(nextBellFrom(new Date(2026, 8, 3, 4, 30, 0)).toISOString()).toBe(
            new Date(2026, 8, 3, 5, 0, 0, 0).toISOString(),
        );
        // Rolls the hour, and the day.
        expect(nextBellFrom(new Date(2026, 8, 3, 23, 47, 0)).toISOString()).toBe(
            new Date(2026, 8, 4, 0, 0, 0, 0).toISOString(),
        );
    });

    it('says the count the way it is said aloud', () => {
        expect(bellsSpoken(1)).toBe('One bell');
        expect(bellsSpoken(5)).toBe('Five bells');
        expect(bellsSpoken(8)).toBe('Eight bells');
    });
});
