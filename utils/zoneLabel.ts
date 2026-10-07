/**
 * A zone as a reader takes it: the IANA name, except UTC and the open-ocean
 * zones tz-lookup returns, shown as their real offset at that instant.
 * 'Etc/GMT+3' is POSIX-signed: it means UTC-3, so printing the ID tells a
 * sailor the opposite of the truth (UX referee 2026-09-26). ASCII minus: the
 * passage PDF's standard fonts have no U+2212.
 *
 * Shared by the passage PDF and the Glass's sun & moon sheet (W1-09).
 */
export function readableZoneName(timeZone: string, atMs: number): string {
    if (!timeZone.startsWith('Etc/') && timeZone !== 'UTC') return timeZone;
    try {
        const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
            .formatToParts(atMs)
            .find((p) => p.type === 'timeZoneName')?.value;
        if (!offset) return timeZone;
        const utc = offset.replace(/^GMT/, 'UTC');
        return /^UTC([+-]0)?$/.test(utc) ? 'UTC' : utc;
    } catch {
        return timeZone;
    }
}
