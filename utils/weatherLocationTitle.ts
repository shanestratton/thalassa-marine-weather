/** User-facing receiver labels must never expose the internal GPS-follow sentinel for a vessel. */
export function vesselLocationLabel(vesselName?: string | null): string {
    return vesselName?.trim() || 'Vessel location';
}

/**
 * `vesselName` is the boat being followed: the account's own for 'boat', the
 * boat it crews on for 'crew' (Shane 2026-10-05: "instead of showing their
 * yacht, can it instead show the yacht that they are now invited to").
 * `unnamedVesselLabel` titles her while no name is known ("Your skipper's
 * boat"); the lookup line then stays plain, never "Finding Your skipper's
 * boat’s location…".
 */
export function weatherLocationTitle(input: {
    locationName?: string | null;
    fallback: string;
    target?: 'phone' | 'boat' | 'crew' | null;
    status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
    vesselName?: string | null;
    unnamedVesselLabel?: string | null;
    retainedWeather?: boolean;
}): { title: string; resolvingLabel: string } {
    const boat = input.target === 'boat' || input.target === 'crew';
    const vessel = vesselLocationLabel(input.vesselName?.trim() || input.unnamedVesselLabel);
    const resolvingLabel = boat
        ? input.vesselName?.trim()
            ? `Finding ${vessel}’s location…`
            : 'Finding vessel location…'
        : 'Finding phone location…';
    let title =
        input.status === 'resolving'
            ? boat
                ? vessel
                : resolvingLabel
            : input.status === 'unavailable' && !input.retainedWeather
              ? `${boat ? 'Boat' : 'Phone'} GPS unavailable`
              : input.locationName || (boat ? vessel : input.fallback);
    if (boat && /^current location$/i.test(title.trim())) title = vessel;
    return { title, resolvingLabel };
}
