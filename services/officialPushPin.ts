/**
 * The official warning push the skipper just tapped (129-06), held for the
 * Warnings page.
 *
 * official-alerts-watch decides each push for the boat's position (its fix,
 * the Guardian fix, the home port...), and the Warnings page answers for the
 * place the forecast is set to. Where they differ, the page alone could say
 * "No official warnings in force here" straight after a gale warning push.
 * So a tap pins the warning it names (provider and identifier, never a
 * position) with the words the lock screen showed and what position it was
 * sent for; the page shows it until it leaves, and says where it was for
 * when its own answer does not hold it.
 */
import { useSyncExternalStore } from 'react';

/** What position the push was decided for: cyclone-watch's BoatBasis. */
export type OfficialPushBasis = 'fix' | 'phone' | 'home' | 'place' | 'old-fix';

export interface OfficialPushPin {
    provider: string;
    identifier: string;
    /** The issuer's event, the push's title. */
    title: string;
    /** The lock screen's body: the issuer's headline and its credit, as sent. */
    body: string;
    basis: OfficialPushBasis | null;
    expires: string | null;
}

const BASES: readonly OfficialPushBasis[] = ['fix', 'phone', 'home', 'place', 'old-fix'];
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

let pin: OfficialPushPin | null = null;
const listeners = new Set<() => void>();
const emit = () => {
    for (const l of listeners) l();
};

/**
 * Pin a tapped official_warning push. `notice` is the notification's own
 * title and body where the platform gives them; else the event in its data.
 */
export function pinOfficialPush(
    data: Readonly<Record<string, unknown>>,
    notice?: Readonly<{ title?: string; body?: string }>,
): void {
    if (data.notification_type !== 'official_warning') return;
    const provider = text(data.provider);
    const identifier = text(data.identifier);
    const title = text(notice?.title) || text(data.event);
    if (!provider || !identifier || !title) return;
    pin = {
        provider,
        identifier,
        title,
        body: typeof notice?.body === 'string' ? notice.body : '',
        basis: BASES.includes(data.basis as OfficialPushBasis) ? (data.basis as OfficialPushBasis) : null,
        expires: text(data.expires) || null,
    };
    emit();
}

/** Taken by the Warnings page: it keeps the pin while it is open. */
export function takeOfficialPushPin(): OfficialPushPin | null {
    const taken = pin;
    if (taken) {
        pin = null;
        emit();
    }
    return taken;
}

export function peekOfficialPushPin(): OfficialPushPin | null {
    return pin;
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

/** The pin waiting for the page, or null. */
export function useOfficialPushPin(): OfficialPushPin | null {
    return useSyncExternalStore(subscribe, peekOfficialPushPin, () => null);
}

/** Where the push was sent for, in the page's words. */
export function officialPushBasisLabel(basis: OfficialPushBasis | null): string {
    switch (basis) {
        case 'fix':
            return 'your boat’s position';
        case 'phone':
            return 'your last reported position';
        case 'home':
            return 'your home port';
        case 'place':
            return 'your weather location';
        case 'old-fix':
            return 'your boat’s last known position';
        default:
            return 'your boat’s position';
    }
}
