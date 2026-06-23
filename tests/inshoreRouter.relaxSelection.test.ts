import { describe, expect, it } from 'vitest';
import { dropsProtectedCanalGateContract } from '../services/inshoreRouterEngine';

describe('inshore router relaxed-pass selection', () => {
    it('does not let a finegrid canal fragment replace a protected Newport egress gate chain', () => {
        const strict = {
            canalMask: [true, false, false],
            debug: { threeTier: 'egress-channel×4 → tier2:chain×4 | tier3:passthrough' },
        };
        const relaxed = {
            canalMask: [false, false, true],
            debug: {
                threeTier: 'rectrc×3 → tier2:astar(gate:entry-land) | tier3:passthrough | tier1:finegrid:k1,real',
            },
        };

        expect(dropsProtectedCanalGateContract(strict, relaxed)).toBe(true);
    });

    it('allows relaxed replacement when the candidate preserves the egress contract', () => {
        const strict = { debug: { threeTier: 'egress-channel×4 → tier2:chain×4 | tier3:passthrough' } };
        const relaxed = {
            debug: { threeTier: 'egress-channel×4 → tier2:chain×4 | tier3:passthrough | tier1:finegrid:k1,real' },
        };

        expect(dropsProtectedCanalGateContract(strict, relaxed)).toBe(false);
    });
});
