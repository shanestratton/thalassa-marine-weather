/**
 * "Official warnings in force here" (129-06): what official_alerts_at answers
 * for the forecast's position, at the head of the Warnings page.
 *
 * - The issuer's words, verbatim: event, headline, description, instruction,
 *   line breaks kept. A long text folds behind "More", clipped only on
 *   screen and only with the control there; every word is in the page.
 * - Issue and expiry times, the issuer, and the credit its licence asks.
 * - The block in the reader's language where the issuer sent one (the
 *   reader's languages in their order, each exactly then by its base
 *   language), else its first, saying which language. The issuer's words
 *   carry its language (lang) and dir="auto", so right-to-left and non-Latin
 *   text reads as sent; the app's own labels stay English for a screen
 *   reader. Spaces and line breaks are kept as sent (pre-wrap), and a
 *   column-aligned table is set in a fixed-width face.
 * - A coverage line per issuer, from the RPC's own states, never a false
 *   all-clear: "No official warnings in force here" only when every issuer
 *   covering the point is live, has placed all it has in force, and the
 *   answer is fresh (a failed refresh keeps the warnings and says so).
 * - The credit of every issuer whose words are shown, from the warning
 *   itself as well as the provider list.
 * - One official style (sky, a radio mast), never the "Forecast:" cards' red
 *   and amber.
 * - A tapped official push (services/officialPushPin.ts) is marked on its
 *   card, or, when this place's answer does not list it, shown on its own
 *   with the position it was sent for.
 */
import React, { useId, useState } from 'react';
import { ExternalLinkIcon, RadioTowerIcon } from '../Icons';
import { formatAge } from '../ui/DataFreshness';
import { useThemeStore } from '../../stores/themeStore';
import { touchTarget } from '../../theme';
import { openExternalUrl } from '../../services/externalLinks';
import {
    officialInForce,
    type OfficialAlert,
    type OfficialAnswer,
    type OfficialInfo,
} from '../../services/officialWarnings';
import { OFFICIAL_WARNINGS_SOURCES, type OfficialWarningsSource } from '../../utils/officialWarningsSource';
import { officialPushBasisLabel, type OfficialPushPin } from '../../services/officialPushPin';

const CARD = 'rounded-2xl border border-sky-300/30 bg-sky-950/60 p-4 text-slate-100';

/** The reader's languages, most preferred first. */
function readerLanguages(): string[] {
    if (typeof navigator === 'undefined') return [];
    const list = [navigator.language, ...(navigator.languages ?? [])];
    return list.filter((l): l is string => typeof l === 'string' && !!l);
}

/**
 * The block to show: the reader's language where the issuer sent one, taking
 * the reader's languages in their order and each exactly, then by its base
 * language, before the next; else the issuer's first. `other` is set when the
 * block is not in the reader's language, so the card can say which it is.
 */
export function pickOfficialInfo(infos: OfficialInfo[]): { info: OfficialInfo; other: boolean } {
    const langs = readerLanguages().map((l) => l.toLowerCase());
    const base = (l: string) => l.toLowerCase().split('-')[0];
    for (const want of langs) {
        const exact = infos.find((i) => i.language.toLowerCase() === want);
        if (exact) return { info: exact, other: false };
        const same = infos.find((i) => base(i.language) === base(want));
        if (same) return { info: same, other: false };
    }
    const first = infos[0];
    const unknown = !first.language;
    return { info: first, other: !unknown && langs.length > 0 && !langs.some((l) => base(l) === base(first.language)) };
}

function when(iso: string | null): string | null {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
    }).format(t);
}

function languageName(tag: string): string {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
    } catch {
        return tag;
    }
}

/** Two or more lines with a run of spaces inside them: a table set in columns (a tsunami's arrival times). */
const tabular = (text: string) => text.split('\n').filter((line) => /\S {2,}\S/.test(line)).length >= 2;

/**
 * The issuer's text, folded behind More when long; clipped on screen only,
 * never cut. Spaces and line breaks as sent (pre-wrap keeps an indent and a
 * column), a table in a fixed-width face.
 */
const Fold: React.FC<{ text: string; testId: string; lang?: string }> = ({ text, testId, lang }) => {
    const id = useId();
    const [open, setOpen] = useState(false);
    const long = text.length > 360 || text.split('\n').length > 8;
    return (
        <>
            <p
                id={id}
                data-testid={testId}
                lang={lang}
                dir="auto"
                className={`mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed${tabular(text) ? ' font-mono text-xs' : ''} ${long && !open ? 'line-clamp-8' : ''}`}
            >
                {text}
            </p>
            {long && (
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => setOpen(!open)}
                    className="-ml-2 min-h-11 px-2 text-sm font-bold text-sky-300"
                >
                    {open ? 'Less' : 'More'}
                </button>
            )}
        </>
    );
};

/** The marine reach of 129-05's official_alerts_at: a marine warning within this of the point is listed. */
const NEARBY_NM = 3;

/** The app's own line on a card: always English, whatever language the issuer wrote in. */
const Label: React.FC<{ gap?: 'mt-1' | 'mt-2'; children: React.ReactNode }> = ({ gap = 'mt-1', children }) => (
    <p lang="en" className={`${gap} text-xs text-slate-300`}>
        {children}
    </p>
);

const Card: React.FC<{ alert: OfficialAlert; pinned?: boolean }> = ({ alert, pinned }) => {
    const titleId = useId();
    const { info, other } = pickOfficialInfo(alert.infos);
    const lang = info.language || undefined;
    const issued = when(alert.sent);
    const until = when(alert.expires ?? info.expires);
    return (
        <article
            aria-labelledby={titleId}
            data-alert-style="official"
            data-pinned={pinned ? 'true' : undefined}
            className={`${CARD}${pinned ? ' ring-2 ring-sky-300/70' : ''}`}
        >
            <p lang="en" className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-sky-200">
                <RadioTowerIcon className="h-4 w-4 shrink-0" />
                Official
                {pinned && <span className="font-semibold normal-case tracking-normal">· From your notification</span>}
            </p>
            <p dir="auto" className="mt-1 text-sm font-semibold text-sky-100">
                {alert.issuer}
            </p>
            <h3 id={titleId} lang={lang} dir="auto" className="mt-1 text-lg font-bold text-white">
                {info.event}
            </h3>
            {info.headline && (
                <p lang={lang} dir="auto" className="mt-1 text-sm font-medium">
                    {info.headline}
                </p>
            )}
            {(issued || until) && (
                <Label gap="mt-2">
                    {[issued && `Issued ${issued}`, until && `Until ${until}`].filter(Boolean).join(' · ')}
                </Label>
            )}
            {alert.matchedBy === 'nearby' && <Label>For the waters within {NEARBY_NM} NM of here</Label>}
            {other && <Label>In {languageName(info.language)}, as issued</Label>}
            {info.description && <Fold text={info.description} lang={lang} testId="official-description" />}
            {info.instruction && <Fold text={info.instruction} lang={lang} testId="official-instruction" />}
        </article>
    );
};

/**
 * The coverage lines, one per issuer covering the point, from the RPC's
 * states; `link` when one of them sends the skipper to the issuer.
 */
export function coverageLines(
    answer: OfficialAnswer,
    nowMs: number,
    shown = officialInForce(answer, nowMs).length,
): { lines: string[]; link: boolean } {
    const lines: string[] = [];
    let link = false;
    if (answer.staleSince) {
        const since = when(answer.staleSince);
        lines.push(`Couldn’t reach Thalassa${since ? ` since ${since}` : ''}`);
        link = true;
    }
    // A warning shown from an issuer whose coverage is not listed here is still a warning: no "no feed" line beside it.
    if (answer.providers.length === 0)
        return { lines: shown > 0 ? lines : [...lines, 'No official feed here yet'], link: true };
    for (const p of answer.providers) {
        if (p.state === 'off') {
            lines.push(`${p.issuer}’s feed isn’t connected yet`);
            link = true;
        } else if (p.state === 'unavailable') {
            const since = when(p.since);
            lines.push(`${p.issuer}’s warnings unavailable${since ? ` since ${since}` : ''}`);
            link = true;
        } else {
            const checked = p.lastSuccessAt ? Date.parse(p.lastSuccessAt) : NaN;
            lines.push(
                `Checked ${Number.isFinite(checked) ? formatAge(Math.max(0, nowMs - checked)) : 'recently'} with ${p.issuer}`,
            );
            if (p.unplaced > 0) {
                lines.push(`Some warnings in force from ${p.issuer} can’t be placed on the map yet`);
                // The newest one not yet placed, anywhere this issuer covers: not necessarily near here.
                const newest = p.unplacedNewest;
                if (newest?.event) {
                    lines.push(
                        `Newest not yet placed, anywhere ${p.issuer} covers: ${[newest.event, newest.areas.join('; ')]
                            .filter(Boolean)
                            .join(' · ')}`,
                    );
                }
                link = true;
            }
        }
    }
    return { lines, link };
}

/** The credits for what is shown: each live issuer's, and every shown warning's own, once per issuer. */
export function officialCredits(
    answer: OfficialAnswer,
    alerts: OfficialAlert[],
): Array<{ id: string; attribution: string; attributionUrl: string | null }> {
    const out = new Map<string, { id: string; attribution: string; attributionUrl: string | null }>();
    for (const p of answer.providers) {
        if (p.attribution && (p.state === 'live' || alerts.some((a) => a.provider === p.id))) {
            out.set(p.id, { id: p.id, attribution: p.attribution, attributionUrl: p.attributionUrl });
        }
    }
    for (const a of alerts) {
        if (a.attribution && !out.has(a.provider)) {
            out.set(a.provider, { id: a.provider, attribution: a.attribution, attributionUrl: a.attributionUrl });
        }
    }
    return [...out.values()];
}

export const OfficialWarningsSection: React.FC<{
    answer: OfficialAnswer;
    /** The issuer for the position (utils/officialWarningsSource.ts): the link where no feed is live. */
    source: OfficialWarningsSource;
    nowMs: number;
    /** A tapped push this answer lists: its card is marked. */
    pinned?: OfficialPushPin | null;
}> = ({ answer, source, nowMs, pinned }) => {
    const headingId = useId();
    const buttonTheme = useThemeStore((s) => s.theme.button);
    const alerts = officialInForce(answer, nowMs);
    const { lines, link } = coverageLines(answer, nowMs, alerts.length);
    // Only a fresh, live answer can say none is in force: a stale one keeps its warnings, not its all-clear.
    const allClear = answer.coverage === 'live' && alerts.length === 0 && !answer.staleSince;
    // The credit of every issuer whose words or answer are shown here.
    const credited = officialCredits(answer, alerts);
    return (
        <section aria-labelledby={headingId} className="space-y-3">
            <h2 id={headingId} className="text-sm font-bold uppercase tracking-wider text-sky-200">
                Official warnings in force here
            </h2>
            {alerts.map((a) => (
                <Card
                    key={`${a.provider}|${a.identifier}`}
                    alert={a}
                    pinned={!!pinned && pinned.provider === a.provider && pinned.identifier === a.identifier}
                />
            ))}
            {allClear && <p className="text-base font-semibold text-slate-100">No official warnings in force here</p>}
            <div className="space-y-1 text-sm leading-snug text-slate-300">
                {lines.map((line) => (
                    <p key={line} dir="auto">
                        {line}
                    </p>
                ))}
            </div>
            {link && (
                <a
                    href={source.url}
                    onClick={(e) => {
                        e.preventDefault();
                        void openExternalUrl(source.url);
                    }}
                    className={`${buttonTheme.secondary} ${touchTarget.button} text-sky-300`}
                >
                    Open {source.shortName} warnings
                    <span className="sr-only"> ({source.name} website)</span>
                    <ExternalLinkIcon className="h-4 w-4 shrink-0" />
                </a>
            )}
            {credited.length > 0 && (
                <p className="text-xs leading-snug text-slate-400">
                    {credited.map((p, i) => (
                        <React.Fragment key={p.id}>
                            {i > 0 && ' · '}
                            {p.attributionUrl ? (
                                <a
                                    href={p.attributionUrl}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        void openExternalUrl(p.attributionUrl!);
                                    }}
                                    className="underline decoration-slate-500 underline-offset-2"
                                >
                                    {p.attribution}
                                </a>
                            ) : (
                                p.attribution
                            )}
                        </React.Fragment>
                    ))}
                </p>
            )}
        </section>
    );
};

/** Whether the answer lists the pinned warning. */
export function answerHolds(answer: OfficialAnswer | null, pin: OfficialPushPin, nowMs: number): boolean {
    return (
        !!answer &&
        officialInForce(answer, nowMs).some((a) => a.provider === pin.provider && a.identifier === pin.identifier)
    );
}

/**
 * A tapped official push this page's answer does not list: the words the lock
 * screen showed, as sent, and the position it was sent for. Its answer is for
 * the place the forecast is set to, which can be another place than the boat.
 */
export const PinnedOfficialPush: React.FC<{
    pin: OfficialPushPin;
    placeName?: string;
}> = ({ pin, placeName }) => {
    const titleId = useId();
    const buttonTheme = useThemeStore((s) => s.theme.button);
    const source = OFFICIAL_WARNINGS_SOURCES[
        (pin.provider.startsWith('meteoalarm') ? 'meteoalarm' : pin.provider) as keyof typeof OFFICIAL_WARNINGS_SOURCES
    ] as OfficialWarningsSource | undefined;
    const until = when(pin.expires);
    return (
        <article
            aria-labelledby={titleId}
            data-alert-style="official"
            data-pinned="true"
            data-testid="official-push-pin"
            className={`${CARD} ring-2 ring-sky-300/70`}
        >
            <p lang="en" className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-sky-200">
                <RadioTowerIcon className="h-4 w-4 shrink-0" />
                Official
                <span className="font-semibold normal-case tracking-normal">· From your notification</span>
            </p>
            <p lang="en" className="mt-1 text-sm font-semibold text-sky-100">
                Sent for {officialPushBasisLabel(pin.basis)}
            </p>
            <h3 id={titleId} dir="auto" className="mt-1 text-lg font-bold text-white">
                {pin.title}
            </h3>
            {pin.body && (
                <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-sm font-medium">
                    {pin.body}
                </p>
            )}
            {until && <Label gap="mt-2">Until {until}</Label>}
            <Label gap="mt-2">
                {placeName ? `Not listed for ${placeName} below. ` : 'Not listed for this page’s place below. '}
                It may be for other waters, or updated since.
            </Label>
            {source && (
                <a
                    href={source.url}
                    onClick={(e) => {
                        e.preventDefault();
                        void openExternalUrl(source.url);
                    }}
                    className={`${buttonTheme.secondary} ${touchTarget.button} mt-3 text-sky-300`}
                >
                    Open {source.shortName} warnings
                    <span className="sr-only"> ({source.name} website)</span>
                    <ExternalLinkIcon className="h-4 w-4 shrink-0" />
                </a>
            )}
        </article>
    );
};
