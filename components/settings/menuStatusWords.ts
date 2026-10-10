/**
 * The live state on each Settings menu row (build 126, 126-14).
 *
 * `text` is what the row shows, `spoken` what VoiceOver hears in the row's
 * name (unchanged from before: "Open Account & Cloud settings, Not signed
 * in"). A `word` state is a short fixed vocabulary that sits whole on the
 * title line or, on a 320 pt phone with no room, not at all; a `free` state (a
 * home port, a boat name) drops under its title when it must
 * (styles/menu-page-fit.css).
 */
export interface SettingsMenuState {
    text: string;
    spoken: string;
    kind: 'word' | 'free';
}

export interface SettingsMenuFacts {
    signedIn: boolean;
    homePort?: string | null;
    vesselName?: string | null;
    /** Crew see the skipper's boat, so the row names none. */
    isObserver?: boolean;
    /** Each alert's settings by name (NotificationPreferences). */
    notifications?: object | null;
    savedLocations?: number;
    /** The public voyage page: live or not, null or absent while unknown. */
    voyageLogLive?: boolean | null;
}

/** Every word a row can show, with its widest counts: the fit spec sweeps these. */
export const SETTINGS_STATE_WORDS = {
    account: ['Signed in', 'Sign in'],
    voyageLog: ['Sign in', 'Live', 'Off'],
    alerts: ['Off', '1 alert on', '12 alerts on'],
    locations: ['None saved', '120 saved'],
} as const;

const word = (text: string, spoken = text): SettingsMenuState => ({ text, spoken, kind: 'word' });
const free = (text: string): SettingsMenuState => ({ text, spoken: text, kind: 'free' });

export function menuStatusFor(id: string, facts: SettingsMenuFacts): SettingsMenuState | null {
    switch (id) {
        case 'general': {
            // What the home port IS, not a bare place: 'Current Location'
            // read as a place or a link (UX scorecard run 8). The town the
            // Glass opens on, without its region: 'Home: Horta'. A GPS fix
            // saved as 'WP -33.0472, -71.6127' keeps both halves; cutting at
            // the comma left a bare latitude.
            const home = facts.homePort?.trim();
            if (!home) return null;
            // 'Home: follows you' took a second read (UX scorecard run 10).
            if (home === 'Current Location') return free('Home: your position');
            if (/^(WP\s|[-+]?\d)/.test(home)) return free(`Home: ${home}`);
            return free(`Home: ${home.split(',')[0].trim() || home}`);
        }
        case 'vessel': {
            const name = facts.vesselName?.trim();
            return name && !facts.isObserver ? free(name) : null;
        }
        case 'alerts': {
            if (!facts.notifications) return null;
            const alerts = Object.values(facts.notifications) as ({ enabled?: boolean } | undefined)[];
            const on = alerts.filter((alert) => alert?.enabled).length;
            return on === 0 ? word('Off', 'All alerts off') : word(on === 1 ? '1 alert on' : `${on} alerts on`);
        }
        case 'account':
            return facts.signedIn ? word('Signed in') : word('Sign in', 'Not signed in');
        case 'locations': {
            const saved = facts.savedLocations ?? 0;
            return word(saved === 0 ? 'None saved' : `${saved} saved`);
        }
        case 'voyageLog':
            if (!facts.signedIn) return word('Sign in', 'Needs sign-in');
            return facts.voyageLogLive == null ? null : word(facts.voyageLogLive ? 'Live' : 'Off');
        default:
            return null;
    }
}
