/** No position may print as 60.000′ (audit 2026-09-02): minutes round first, then carry. */
import { describe, expect, it } from 'vitest';
import { formatLatDegMin, formatLonDegMin } from '../utils/formatDegMin';

describe('degrees and decimal minutes', () => {
    it('reads ordinary positions the way they are said on the radio', () => {
        expect(formatLatDegMin(-19.26)).toBe('19°15.600′S');
        expect(formatLatDegMin(-27.1)).toBe('27°06.000′S'); // two-digit minutes, as on a DSC set
        expect(formatLonDegMin(146.82)).toBe('146°49.200′E');
        expect(formatLonDegMin(-71.31)).toBe('071°18.600′W');
    });
    it('carries a full sixty minutes into the degrees', () => {
        expect(formatLatDegMin(19.999999)).toBe('20°00.000′N');
        expect(formatLonDegMin(-179.9999999)).toBe('180°00.000′W');
        expect(formatLatDegMin(19.99999)).not.toMatch(/60\.000/);
    });
});
