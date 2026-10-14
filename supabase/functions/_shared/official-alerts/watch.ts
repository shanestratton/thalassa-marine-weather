/**
 * official-alerts-watch's decisions (129-06), pure so every rule has a test
 * (tests/OfficialAlertsWatch.test.ts). The edge function reads the boats, the
 * warnings in force at each (official_alerts_watch_match) and the deliveries
 * so far, and writes what this returns.
 *
 * What pushes (decision B, 14 Oct; classify.ts officialPushClass):
 *   - marine and coastal warnings at the boat; land types, statements and
 *     unknown events stay in the app;
 *   - Severe and Extreme at once, day or night (a marine or coastal warning
 *     at least Severe, a tsunami always Extreme), Time Sensitive;
 *   - Moderate and Minor (a Small Craft Advisory, a watch) as advisories:
 *     "Small craft advisories" off mutes them, and one due 22:00-07:00 at the
 *     boat waits for 07:00 unless its onset is within 3 h (or past). The
 *     boat's clock is the IANA zone of its position, as cyclone-watch keeps it.
 * Once per boat per warning (official_alert_deliveries):
 *   - a warning already delivered to the account is never sent again;
 *   - an update is a chain: its push carries the chain's collapse id,
 *     provider:chain, so it replaces the notification on the lock screen;
 *     quietly (no sound) unless its severity is higher than the last one the
 *     account was told in that chain, which buzzes again;
 *   - NWS's chain is its VTEC event (office, phenomenon, significance and
 *     event number): NWS often sends a continuing event (CON, EXB) as a fresh
 *     Alert naming no references. A VTEC message that ends or replaces its
 *     event (CAN, EXP, UPG: "The Small Craft Advisory has been replaced")
 *     never starts a notification of its own and never sounds; it only
 *     replaces one the account already has, quietly;
 *   - any other issuer's chain is the CAP references (an alert whose
 *     references name a delivered one, or one that names the same message);
 *   - a chain's key is a hash of the provider and the VTEC event, else the
 *     first identifier delivered, so a re-run gives the same id.
 * The push: the issuer's event as the title, its headline as the body (the
 * reader's language is not known on the server, so English where the issuer
 * sent it, else its first block), and the credit its licence asks as the last
 * line where it fits. A MeteoAlarm warning (129-05b) is titled as its Style
 * Guide asks ("Orange Coastal Event Warning"), and its last line names the
 * national service and the time of issue on the boat's clock (MeteoAlarm's
 * rules 2 and 3), always, then www.meteoalarm.org (rule 4) where it fits.
 * Its data names the warning (provider and identifier)
 * and what position it was decided for (the basis: the boat's fix, the home
 * port...), so a tap can show it on a Warnings page set to another place.
 * Never a coordinate, in the payload or anywhere it logs.
 */
import { type Boat, type BoatBasis, boatZone, type FixRow, isQuietHour, resolveBoat } from '../cyclone/watch.ts';
import { type CapSeverity, classifyOfficialEvent, officialPushClass, severityRank } from './classify.ts';
import { isMeteoAlarm, METEOALARM_LINK_TEXT, meteoAlarmSource, meteoAlarmTitle } from './meteoalarm.ts';
import type { StoredInfo } from './normalize.ts';

/** An advisory due inside this of now is sent at night: it is about to begin. */
export const ONSET_SOON_MS = 3 * 3_600_000;
/** send-push's body limit (push_notification_queue's CHECK and send-push's 422). */
const BODY_MAX = 500;
const TITLE_MAX = 120;
/** The longest MeteoAlarm participant a push names before it is cut (the longest listed is 112). */
const METEOALARM_SOURCE_MAX = 200;

export interface WatchAlert {
    id: number;
    provider: string;
    identifier: string;
    /** The CAP sender: which participant a MeteoAlarm warning is from, where a country has several. */
    sender?: string | null;
    refs: string[];
    zones: string[];
    sentAt: string;
    onsetAt: string | null;
    effectiveAt: string | null;
    expiresAt: string | null;
    infos: StoredInfo[];
    attribution: string;
}

export interface PriorDelivery {
    userId: string;
    alertId: number;
    provider: string;
    identifier: string;
    refs: string[];
    chainKey: string;
    /** The severity this delivery told the account. */
    severity: string;
    /** When it was delivered (ISO): the last in a chain is what the lock screen shows. */
    deliveredAt: string;
}

export interface WatchedBoat extends Boat {
    /** "Small craft advisories": Moderate and Minor marine warnings may push. */
    advisories: boolean;
}

export interface OfficialPushData {
    provider: string;
    /** The warning's CAP identifier, so a tap can find it on the Warnings page. */
    identifier: string;
    /** What position it was decided for (never the position itself). */
    basis: BoatBasis;
    /** send-push's apns-collapse-id: one notification per warning and its updates. */
    collapse: string;
    severity: CapSeverity;
    /** When APNs may stop trying (send-push's TTL), and after which it is not delivered. */
    expires: string | null;
    /** An update that raised nothing: it replaces the notification without a sound. */
    silent: boolean;
    event: string;
}

export interface OfficialPush {
    userId: string;
    type: 'official_warning';
    title: string;
    body: string;
    data: OfficialPushData;
}

export interface OfficialDelivery {
    user_id: string;
    alert_id: number;
    channel: 'push';
    provider_id: string;
    identifier: string;
    refs: string[];
    chain_key: string;
    severity: CapSeverity;
    silent: boolean;
}

/** The boat's position for an account, or null: none, or "Official marine warnings at the boat" off. */
export function officialWatchBoat(
    userId: string,
    src: { settings: Record<string, unknown> | null; telemetry?: FixRow | null; phone?: FixRow | null },
    nowMs: number,
): WatchedBoat | null {
    const settings = src.settings ?? {};
    if (settings.officialMarineWarnings === false) return null;
    // cyclone-watch's resolveBoat, without the cyclone switch: each push has its own.
    const boat = resolveBoat(userId, src, nowMs, null);
    return boat ? { ...boat, advisories: settings.smallCraftAdvisories !== false } : null;
}

/** The info block the push reads: English where the issuer sent it, else the issuer's first. */
export function pushInfo(infos: StoredInfo[]): StoredInfo | undefined {
    return infos.find((i) => /^en\b/i.test(i.language ?? '')) ?? infos[0];
}

/** FNV-1a, 64 bit, as 16 hex digits: a stable, short chain key. */
export function chainKeyFor(provider: string, identifier: string): string {
    let h = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(`${provider}\u0000${identifier}`)) {
        h ^= BigInt(byte);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, '0');
}

const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    const room = text.slice(0, max - 1);
    const space = room.lastIndexOf(' ');
    return `${(space > max * 0.6 ? room.slice(0, space) : room).trimEnd()}…`;
};

/** A time on the boat's clock, with its zone ("14 Oct, 07:30 CEST"); a nautical zone reads "UTC+2". */
export function boatTime(iso: string, zone: string | number = 'UTC'): string | null {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    if (typeof zone === 'string') {
        try {
            return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: zone, timeZoneName: 'short' }).format(ms);
        } catch {
            zone = 0;
        }
    }
    const text = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(ms + zone * 3_600_000);
    return `${text} UTC${zone === 0 ? '' : `${zone > 0 ? '+' : '-'}${Math.abs(zone)}`}`;
}

/**
 * The title and body: the issuer's event and headline (else the first line
 * of its description), as written, and its credit last where it fits. A
 * headline longer than the lock screen allows is ended with an ellipsis; the
 * Warnings page holds every word. A MeteoAlarm warning's credit is its
 * national service, the time it was issued on the boat's clock (`zone`), and
 * www.meteoalarm.org: the link is dropped when the headline leaves no room
 * for it, and the headline is cut before the service or the time ever is.
 */
export function officialPushText(
    alert: WatchAlert,
    info: StoredInfo,
    zone: string | number = 'UTC',
): { title: string; body: string } {
    const meteo = isMeteoAlarm(alert.provider);
    const title = cut(
        (meteo && meteoAlarmTitle(info.parameters)) || info.event.trim() || 'Official warning',
        TITLE_MAX,
    );
    const lead = (info.headline?.trim() || info.description?.trim().split('\n')[0]?.trim() || title).trim();
    if (meteo) {
        // The participant and the issue time always go (MeteoAlarm's rules 2 and 3): only the link is
        // dropped, and then the headline is cut, to make room for them.
        const source = cut(meteoAlarmSource(alert.provider, alert.sender, info.senderName), METEOALARM_SOURCE_MAX);
        const issued = boatTime(alert.sentAt, zone);
        const kept = [source, issued && `Issued ${issued}`].filter((p): p is string => !!p).join(' · ');
        const full = `${kept} · ${METEOALARM_LINK_TEXT}`;
        if (lead.length + 1 + full.length <= BODY_MAX) return { title, body: `${lead}\n${full}` };
        return { title, body: `${cut(lead, BODY_MAX - 1 - kept.length)}\n${kept}` };
    }
    const credit = alert.attribution.trim();
    return {
        title,
        body: credit && lead.length + 1 + credit.length <= BODY_MAX ? `${lead}\n${credit}` : cut(lead, BODY_MAX),
    };
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** VTEC actions that end or replace the event: they never start a notification, and never sound. */
const VTEC_ENDING = new Set(['CAN', 'EXP', 'UPG']);

/**
 * An NWS message's VTEC event (parameters.VTEC, "/O.CON.KCAR.SC.Y.0073.…/"):
 * its action and the event it belongs to, office.phenomenon.significance.ETN,
 * or null without one. Operational (O) and experimental-in-operation (X) only.
 */
export function nwsVtec(infos: readonly StoredInfo[]): { action: string; event: string } | null {
    for (const info of infos) {
        for (const p of info.parameters ?? []) {
            if (!/^VTEC$/i.test(p.valueName)) continue;
            const m = /^\/[OX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(p.value.trim());
            if (m) return { action: m[1], event: `${m[2]}.${m[3]}.${m[4]}.${m[5]}` };
        }
    }
    return null;
}

/**
 * Prior deliveries of the same warning chain to this account: by the chain
 * key where the issuer names its event (NWS VTEC), else by the references
 * either side names.
 */
function chainOf(alert: WatchAlert, prior: PriorDelivery[], key: string | null): PriorDelivery[] {
    if (key) return prior.filter((p) => p.provider === alert.provider && p.alertId !== alert.id && p.chainKey === key);
    const names = new Set([alert.identifier, ...alert.refs]);
    return prior.filter(
        (p) =>
            p.provider === alert.provider &&
            p.alertId !== alert.id &&
            (names.has(p.identifier) || p.refs.some((r) => names.has(r)) || p.refs.includes(alert.identifier)),
    );
}

/** The chain's last delivery: what the lock screen shows now, whatever was stronger before. */
function lastTold(chain: PriorDelivery[]): PriorDelivery | null {
    // A stable sort: deliveries of one run share a time and keep their order.
    return [...chain].sort((a, b) => (ms(a.deliveredAt) || 0) - (ms(b.deliveredAt) || 0)).at(-1) ?? null;
}

/**
 * One run: every boat against the warnings in force at it. `matches` is keyed
 * by userId; `prior` holds the deliveries already made to those accounts.
 */
export function decideOfficialPushes(input: {
    boats: WatchedBoat[];
    matches: Map<string, WatchAlert[]>;
    prior: PriorDelivery[];
    nowMs: number;
    zoneAt?: (lat: number, lon: number) => string;
}): { sends: Array<{ push: OfficialPush; delivery: OfficialDelivery }>; held: number } {
    const { nowMs } = input;
    const nowIso = new Date(nowMs).toISOString();
    const sends: Array<{ push: OfficialPush; delivery: OfficialDelivery }> = [];
    let held = 0;
    const byUser = new Map<string, PriorDelivery[]>();
    for (const p of input.prior) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
    for (const boat of input.boats) {
        const prior = [...(byUser.get(boat.userId) ?? [])];
        const zone = boatZone(boat.position, input.zoneAt);
        const alerts = [...(input.matches.get(boat.userId) ?? [])].sort(
            (a, b) => ms(a.sentAt) - ms(b.sentAt) || a.id - b.id,
        );
        for (const alert of alerts) {
            if (prior.some((p) => p.alertId === alert.id)) continue;
            const expires = ms(alert.expiresAt);
            if (Number.isFinite(expires) && expires <= nowMs) continue;
            const info = pushInfo(alert.infos);
            if (!info) continue;
            // The blocks are one warning in several languages: the first that names a known
            // event, the push's own block first, says what it is.
            const classes = [info, ...alert.infos.filter((i) => i !== info)].map((i) =>
                classifyOfficialEvent(alert.provider, i, alert.zones)
            );
            const cls = classes.find((c) => c.domain !== 'unknown') ?? classes[0];
            const verdict = officialPushClass(cls, info.severity);
            if (!verdict.push) continue;
            if (!verdict.urgent && !boat.advisories) continue;
            const vtec = alert.provider === 'nws' ? nwsVtec(alert.infos) : null;
            const vtecKey = vtec ? chainKeyFor(alert.provider, `vtec:${vtec.event}`) : null;
            const chain = chainOf(alert, prior, vtecKey);
            // "Has been cancelled / replaced": only ever a quiet replacement of what the account has.
            const ending = vtec !== null && VTEC_ENDING.has(vtec.action);
            if (ending && chain.length === 0) continue;
            // The last the account was told in this chain: a rise above it buzzes again.
            const told = lastTold(chain);
            const silent = ending || (told !== null && severityRank(verdict.severity) <= severityRank(told.severity));
            if (!silent && !verdict.urgent && isQuietHour(nowMs, zone)) {
                const onset = ms(alert.onsetAt ?? info.onset ?? alert.effectiveAt);
                if (!(Number.isFinite(onset) && onset <= nowMs + ONSET_SOON_MS)) {
                    held++;
                    continue;
                }
            }
            const chainKey = vtecKey ?? told?.chainKey ?? chainKeyFor(alert.provider, alert.identifier);
            const { title, body } = officialPushText(alert, info, zone);
            // What this message told: the next update sounds only if it rises above it.
            const severity = verdict.severity;
            const delivery: OfficialDelivery = {
                user_id: boat.userId,
                alert_id: alert.id,
                channel: 'push',
                provider_id: alert.provider,
                identifier: alert.identifier,
                refs: alert.refs,
                chain_key: chainKey,
                severity,
                silent,
            };
            sends.push({
                push: {
                    userId: boat.userId,
                    type: 'official_warning',
                    title,
                    body,
                    data: {
                        provider: alert.provider,
                        identifier: alert.identifier,
                        basis: boat.basis,
                        collapse: `${alert.provider}:${chainKey}`,
                        severity: verdict.severity,
                        expires: alert.expiresAt,
                        silent,
                        event: info.event,
                    },
                },
                delivery,
            });
            // A later alert in the same run may update this one.
            prior.push({
                userId: boat.userId,
                alertId: alert.id,
                provider: alert.provider,
                identifier: alert.identifier,
                refs: alert.refs,
                chainKey,
                severity,
                deliveredAt: nowIso,
            });
        }
    }
    return { sends, held };
}
