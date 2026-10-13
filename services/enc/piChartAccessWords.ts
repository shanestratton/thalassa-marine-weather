/**
 * Plain words for each way the boat's Pi can say no to charts (127-C-d).
 *
 * Pi update 3 refuses with a code in a JSON body (`{code}`), which
 * PiPairingService surfaces as `PiHttpError.code`. One sentence each, with the
 * boat named from the pairing, never a status number. 'pi-needs-update' is the
 * app's own: today's Pi (update 2) has no chart device routes at all. So is
 * 'chart-device-not-kept': the Keychain refused a token the Pi had issued. The Pi's
 * install and routing refusals ('installs-paused', 'not-open-chart',
 * 'routing-on-phone') carry their own sentence in `error`, which the callers
 * of those routes already show.
 *
 * `quiet` marks the answers that are normal where they happen rather than a
 * fault: off the boat's Wi-Fi (the tailnet from home), a Pi still opening its
 * charts, a Pi one update behind. 127-C-c's status line shows those muted.
 */

export const CHART_ACCESS_CODES = [
    'charts-boat-wifi-only',
    'chart-device-not-enrolled',
    'chart-device-removed',
    'chart-device-limit',
    'chart-code-invalid',
    'chart-code-tries',
    'vault-starting',
    'vault-busy',
    'vault-decoder-down',
    'pi-needs-update',
    'chart-device-not-kept',
] as const;

export type ChartAccessCode = (typeof CHART_ACCESS_CODES)[number];

export interface ChartAccessWords {
    text: string;
    /** Not an error: the normal answer in this place or moment. */
    quiet: boolean;
}

const QUIET = new Set<string>(['charts-boat-wifi-only', 'vault-starting', 'vault-busy', 'pi-needs-update']);

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function chartAccessWords(code: string | undefined, boatName?: string): ChartAccessWords {
    const boat = boatName?.trim() || 'your boat';
    const her = `${boat}'s`;
    const words: Record<ChartAccessCode, string> = {
        'charts-boat-wifi-only': `Charts come over ${her} own Wi-Fi. Join it to get charts.`,
        'chart-device-not-enrolled': `This device isn't set up for ${her} charts yet. Type the code from ${her} Pi, or from a phone already set up.`,
        'chart-device-removed': `This device was removed from ${her} charts. Type a new code to add it again.`,
        'chart-device-limit': `Five phones and tablets already get ${her} charts. Remove one to add this one.`,
        'chart-code-invalid': "That code didn't work. Codes last 15 minutes: get a fresh one and try again.",
        'chart-code-tries': 'Too many wrong codes. Wait 10 minutes, then try again.',
        'vault-starting': `${cap(her)} Pi is opening her charts in memory. Give it a few minutes.`,
        'vault-busy': `${cap(her)} Pi is busy opening charts. Try again in a minute.`,
        'vault-decoder-down': `${cap(boat)} can't open her charts. Check the o-charts dongle is plugged into the Pi.`,
        'pi-needs-update': `${cap(her)} Pi needs its next update to set up charts here. Charts keep coming as they do now.`,
        'chart-device-not-kept':
            "Set up for now, but this device couldn't save its chart key. If charts stop after a restart, set it up again.",
    };
    const text = words[code as ChartAccessCode];
    return typeof text === 'string'
        ? { text, quiet: QUIET.has(code!) }
        : { text: `${cap(her)} Pi couldn't answer for charts just now. Try again in a minute.`, quiet: false };
}
