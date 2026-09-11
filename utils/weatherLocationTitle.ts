/** User-facing receiver labels must never expose the internal GPS-follow sentinel for a vessel. */
export function vesselLocationLabel(vesselName?: string | null): string {
    return vesselName?.trim() || 'Vessel location';
}

export function weatherLocationTitle(input: {
    locationName?: string | null;
    fallback: string;
    target?: 'phone' | 'boat' | null;
    status?: 'live' | 'last-known' | 'unavailable' | 'resolving';
    vesselName?: string | null;
    retainedWeather?: boolean;
}): { title: string; resolvingLabel: string } {
    const boat = input.target === 'boat';
    const vessel = vesselLocationLabel(input.vesselName);
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
