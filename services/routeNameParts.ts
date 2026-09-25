/** One route-name grammar for reversal, saved-route ports and trip labels. */
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
