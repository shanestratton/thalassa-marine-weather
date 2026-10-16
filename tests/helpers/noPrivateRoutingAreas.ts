/** These older synthetic routing scenes have no private files or park source.
 * Actual persistence/source retirement is exercised by RoutingExclusionsContext139. */
import { vi } from 'vitest';
export const routingAreasFixture = {
    revision: 0,
    unavailable: false,
    leaseValid: true,
    reads: 0,
    releases: 0,
};
vi.mock('../../services/routing/routingExclusions', () => ({
    routingExclusionContextKey: () => `fixture:no-private-routing-areas:${routingAreasFixture.revision}`,
    readCurrentRoutingExclusions: async ({ signal }: { signal?: AbortSignal }) => {
        signal?.throwIfAborted();
        routingAreasFixture.reads++;
        if (routingAreasFixture.unavailable) throw Error('Synthetic damaged hard-policy index');
        const revision = routingAreasFixture.revision;
        let active = true;
        return {
            manual: undefined,
            marineParks: undefined,
            advisories: [],
            isCurrent: () =>
                active &&
                !signal?.aborted &&
                routingAreasFixture.leaseValid &&
                revision === routingAreasFixture.revision,
            release: () => {
                if (active) routingAreasFixture.releases++;
                active = false;
            },
        };
    },
}));
