/** One route-name grammar for reversal, saved-route ports and trip labels. */

/**
 * Badges the app writes onto a route name: "(2nd Leg)", "(Leg 2)",
 * "(Passage)" and "(3 legs)". They describe where a route sits in a trip, not
 * where it goes, so they belong at the end and never travel with a reversal.
 */
const ROUTE_BADGE_RE = /\s*\((?:\d+(?:st|nd|rd|th) Leg|Leg \d+|Passage|\d+ legs)\)\s*$/i;

export function routeNameParts(name: string): { places: string[]; separator: string; suffix: string } | null {
    const trimmed = name.trim();
    // Badges describe the whole route, not the last port. Keep them at the end.
    const suffix = trimmed.match(/\s+\((?:\d+(?:st|nd|rd|th) Leg|Leg \d+|Passage|\d+ legs)\)$/i)?.[0] ?? '';
    const body = suffix ? trimmed.slice(0, -suffix.length) : trimmed;
    const separators: Array<[RegExp, string]> = [
        [/\s*→\s*/, ' → '],
        [/\s*->\s*/, ' -> '],
        [/\s+—\s+/, ' — '],
        [/\s+–\s+/, ' – '],
        [/\s+-\s+/, ' - '],
        [/\s+to\s+/i, ' to '],
    ];
    for (const [pattern, separator] of separators) {
        const places = body.split(pattern).map((part) => part.trim());
        if (places.length > 1 && places.every(Boolean)) return { places, separator, suffix };
    }
    return null;
}

/** Custom titles without a directional separator remain the skipper's words. */
export function reverseRouteName(name: string): string {
    const parsed = routeNameParts(name);
    return parsed ? [...parsed.places].reverse().join(parsed.separator) + parsed.suffix : name;
}

/** Remove every trailing trip badge ("(2nd Leg)", "(Passage)", "(3 legs)"). */
export function stripRouteBadges(name: string): string {
    let current = name.trim();
    for (;;) {
        const next = current.replace(ROUTE_BADGE_RE, '').trim();
        if (next === current) return current;
        current = next;
    }
}

/**
 * The name a reversed copy of a route starts with. The places flip and every
 * trip badge goes: a reversed "(2nd Leg)" is a new route, not leg 2 of the
 * outbound trip, and a stale badge made Cast Off seed it as leg 2 and the Trip
 * box offer "Plot the 3rd leg" (2026-10-07). A name with no separator (a custom
 * title, or one written in a script the separators don't cover) keeps the
 * skipper's words, badge-free.
 */
export function reversedLegName(name: string): string {
    return reverseRouteName(stripRouteBadges(name));
}
