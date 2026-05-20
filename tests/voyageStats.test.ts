/**
 * Tests for voyageStats — locks in the "suggested routes don't count as
 * sailed miles" invariant that fixed the Ship's Log stat totals
 * (planned routes were inflating distance / time / voyage counts).
 */
import { describe, expect, it } from 'vitest';
import { isPlannedRouteGroup, excludeSuggestedRoutes, type SourcedGroup } from '../utils/voyageStats';

const sailed: SourcedGroup = { entries: [{ source: 'device' }, { source: 'device' }] };
const legacy: SourcedGroup = { entries: [{ source: undefined }] }; // pre-source-tagging entries
const planned: SourcedGroup = { entries: [{ source: 'planned_route' }] };
const mixed: SourcedGroup = { entries: [{ source: 'device' }, { source: 'planned_route' }] };

describe('isPlannedRouteGroup', () => {
    it('flags a group with any planned_route entry', () => {
        expect(isPlannedRouteGroup(planned)).toBe(true);
        expect(isPlannedRouteGroup(mixed)).toBe(true);
    });

    it('does not flag sailed or legacy (untagged) groups', () => {
        expect(isPlannedRouteGroup(sailed)).toBe(false);
        expect(isPlannedRouteGroup(legacy)).toBe(false);
    });

    it('treats an empty group as not-planned', () => {
        expect(isPlannedRouteGroup({ entries: [] })).toBe(false);
    });
});

describe('excludeSuggestedRoutes', () => {
    it('drops every group containing a planned_route entry', () => {
        const groups = [sailed, planned, legacy, mixed];
        const result = excludeSuggestedRoutes(groups);
        expect(result).toEqual([sailed, legacy]);
    });

    it('keeps all groups when none are planned', () => {
        expect(excludeSuggestedRoutes([sailed, legacy])).toHaveLength(2);
    });

    it('returns empty when every group is a suggested route', () => {
        expect(excludeSuggestedRoutes([planned, mixed])).toHaveLength(0);
    });

    it('regression: a saved suggested route does not add to the voyage count', () => {
        // Top gauge tile counts sailedVoyageGroups.length. Two real
        // voyages + one saved suggestion must read as 2, not 3.
        const groups = [sailed, legacy, planned];
        expect(excludeSuggestedRoutes(groups)).toHaveLength(2);
    });
});
