/**
 * The Warnings page leads with the official warnings in force here (129-06),
 * from official_alerts_at (129-05), once that answers:
 * - in the issuer's own words, verbatim, line breaks kept, a long text folded
 *   behind "More" and never cut short;
 * - with its issue and expiry times, its issuer and the credit its licence asks;
 * - in the reader's language where the issuer sent one, else the issuer's
 *   first, said when it differs; right-to-left and non-Latin text as sent;
 * - with a coverage line that never gives a false all-clear: "No official
 *   warnings in force here" only when every issuer there is live;
 * - in its own style, never the "Forecast:" alerts' style.
 * Until the RPC answers (not deployed, signed out, offline), the page is
 * today's Forecast alerts page with its position-aware link. Once it has
 * answered, a failed refresh keeps the warnings and says it could not check.
 * A tapped official push is shown even where this page's place is not the
 * boat's, with the position it was sent for.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setPage: vi.fn(), openExternalUrl: vi.fn(async () => undefined) }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: mocks.setPage }) }));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: mocks.openExternalUrl }));

import { supabase } from '../services/supabase';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { WarningDetails } from '../components/WarningDetails';
import {
    clearOfficialWarningsCache,
    fetchOfficialWarnings,
    OFFICIAL_REFRESH_MS,
    REALTIME_ANSWER_MS,
    REALTIME_REFRESH_MS,
} from '../services/officialWarnings';
import { REALTIME_APP_MS } from '../supabase/functions/_shared/official-alerts/ingest';
import { pinOfficialPush, peekOfficialPushPin, takeOfficialPushPin } from '../services/officialPushPin';
import { OFFICIAL_WARNINGS_SOURCES } from '../utils/officialWarningsSource';
import {
    METEOALARM_DISCLAIMER,
    METEOALARM_LINK,
    METEOALARM_SOURCE,
} from '../supabase/functions/_shared/official-alerts/meteoalarm';

type Answer = Record<string, unknown> & { lat: number; lon: number; alerts: Array<Record<string, any>> };
const FIXTURES = JSON.parse(readFileSync('tests/fixtures/official-alerts/rpc-answers.json', 'utf8')) as {
    anchor: string;
    answers: Record<string, Answer>;
};
const rpc = vi.mocked(supabase!.rpc);
const SECTION = { name: 'Official warnings in force here' };

function answering(name: string | null, error: unknown = null) {
    rpc.mockImplementation((async (fn: string) => {
        if (fn !== 'official_alerts_at') return { data: null, error: null };
        if (error) return { data: null, error };
        return { data: name ? structuredClone(FIXTURES.answers[name]) : null, error: null };
    }) as never);
}

async function show(name: string, extra: Partial<React.ComponentProps<typeof WarningDetails>> = {}) {
    const a = FIXTURES.answers[name];
    answering(name);
    render(
        <WarningDetails
            alerts={[]}
            placeName="Zzbaytown"
            coordinates={{ lat: a.lat, lon: a.lon }}
            locationType="coastal"
            checkedAt={FIXTURES.anchor}
            {...extra}
        />,
    );
    return screen.findByRole('region', SECTION);
}

let language: PropertyDescriptor | undefined;
let languages: PropertyDescriptor | undefined;
beforeEach(() => {
    // official_alerts_at is for signed-in users; the app never asks signed out.
    setAuthIdentityScope('fixture-skipper');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXTURES.anchor));
    clearOfficialWarningsCache();
    rpc.mockReset();
    mocks.openExternalUrl.mockClear();
    takeOfficialPushPin();
    sessionStorage.clear();
    language = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
    languages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
});
afterEach(() => {
    setAuthIdentityScope(null);
    cleanup();
    vi.useRealTimers();
    if (language) Object.defineProperty(Navigator.prototype, 'language', language);
    if (languages) Object.defineProperty(Navigator.prototype, 'languages', languages);
});
/** The reader's language, as the browser reports it (navigator.language and its list). */
const setLanguage = (tag: string, ...more: string[]) => {
    Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get: () => tag });
    Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: () => [tag, ...more] });
};
/** The language a screen reader would speak an element in: its nearest lang. */
const spokenIn = (el: Element) => el.closest('[lang]')?.getAttribute('lang') ?? null;

describe('until official_alerts_at answers, the page is today’s', () => {
    for (const [why, setup] of [
        ['the function is not deployed', () => answering(null, { code: 'PGRST202', message: 'not found' })],
        ['signed out (no permission)', () => answering(null, { code: '42501', message: 'permission denied' })],
        ['no answer', () => answering(null)],
    ] as const) {
        it(`keeps the position-aware link when ${why}`, async () => {
            setup();
            render(<WarningDetails alerts={[]} placeName="Zzbaytown" coordinates={{ lat: 39.1, lon: -76.4 }} />);
            await act(async () => undefined);
            expect(rpc).toHaveBeenCalledWith('official_alerts_at', { p_lat: 39.1, p_lon: -76.4 });
            expect(screen.getByRole('heading', { level: 1, name: 'Forecast alerts' })).toBeInTheDocument();
            expect(screen.queryByRole('region', SECTION)).toBeNull();
            expect(screen.getByRole('link', { name: /Open NWS warnings/ })).toHaveAttribute(
                'href',
                OFFICIAL_WARNINGS_SOURCES.nws.url,
            );
        });
    }
});

describe('official warnings in force', () => {
    it('lead the page, in the issuer’s words, with times, issuer and credit', async () => {
        const section = await show('inforce');
        expect(screen.getByRole('heading', { level: 1, name: 'Warnings' })).toBeInTheDocument();
        // The section comes before the forecast alerts.
        const forecast = screen.getByRole('heading', { level: 2, name: 'Forecast alerts' });
        expect(section.compareDocumentPosition(forecast) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        const cards = within(section).getAllByRole('article');
        expect(cards.map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual([
            'Special Marine Warning',
            'Small Craft Advisory',
        ]);
        const smw = FIXTURES.answers.inforce.alerts[0].infos[0];
        const card = cards[0];
        expect(within(card).getByText('National Weather Service (NOAA)')).toBeInTheDocument();
        expect(within(card).getByText(smw.headline)).toBeInTheDocument();
        // Verbatim: every character and line break of the description and instruction.
        const description = within(card).getByTestId('official-description');
        expect(description.textContent).toBe(smw.description);
        // Line breaks kept: the issuer's paragraphs and starred items stay on their own lines.
        expect(description.className).toMatch(/\bwhitespace-pre-(?:line|wrap)\b/);
        expect(within(card).getByTestId('official-instruction').textContent).toBe(smw.instruction);
        // The issue and expiry times, on their own line (the issuer's own text says "Until 845 AM EDT" too).
        expect(within(card).getByText(/^Issued .+ · Until .+$/)).toBeInTheDocument();
        expect(within(section).getByText('Warnings: National Weather Service (NOAA)')).toBeInTheDocument();
        expect(within(section).getByText(/^Checked .* with National Weather Service \(NOAA\)$/)).toBeInTheDocument();
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('folds a long text behind More, never cutting it', async () => {
        const section = await show('inforce');
        const sca = within(section).getAllByRole('article')[1];
        const text = FIXTURES.answers.inforce.alerts[1].infos[0].description;
        const description = within(sca).getByTestId('official-description');
        // Every word is there before More is pressed.
        expect(description.textContent).toBe(text);
        const more = within(sca).getByRole('button', { name: 'More' });
        expect(more).toHaveAttribute('aria-expanded', 'false');
        expect(more).toHaveAttribute('aria-controls', description.id);
        fireEvent.click(more);
        expect(within(sca).getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
        expect(description.textContent).toBe(text);
    });

    it('drops an expired warning, and says none is in force only because the issuer is live', async () => {
        const section = await show('expired');
        expect(within(section).queryByRole('article')).toBeNull();
        expect(within(section).getByText('No official warnings in force here')).toBeInTheDocument();
    });

    it('says none is in force when the issuer is live and has none', async () => {
        const section = await show('clear');
        expect(within(section).getByText('No official warnings in force here')).toBeInTheDocument();
    });
});

describe('never a false all-clear', () => {
    it('under the official section, the forecast answer is words alone: one issuer link, the official one', async () => {
        const section = await show('none');
        expect(screen.getByRole('heading', { level: 3, name: 'No forecast alerts for Zzbaytown' })).toBeInTheDocument();
        expect(
            screen.getByText(/It is not an official warning service; for the issuer’s own warnings, see above\./),
        ).toBeInTheDocument();
        const links = screen.getAllByRole('link', { name: /Open .* warnings/ });
        expect(links).toHaveLength(1);
        expect(section).toContainElement(links[0]);
    });

    it('partial: some warnings cannot be placed yet; the newest is named, with the link', async () => {
        const section = await show('partial');
        expect(
            within(section).getByText(
                'Some warnings in force from National Weather Service (NOAA) can’t be placed on the map yet',
            ),
        ).toBeInTheDocument();
        expect(within(section).getByText(/Gale Warning/)).toBeInTheDocument();
        expect(within(section).getByText(/Fictional Sound out 20 NM/)).toBeInTheDocument();
        expect(within(section).getByRole('link', { name: /Open NWS warnings/ })).toHaveAttribute(
            'href',
            OFFICIAL_WARNINGS_SOURCES.nws.url,
        );
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('unavailable: since when, with the link', async () => {
        const section = await show('unavailable');
        expect(
            within(section).getByText(/^Environment and Climate Change Canada’s warnings unavailable since /),
        ).toBeInTheDocument();
        expect(within(section).getByRole('link', { name: /Open Environment Canada warnings/ })).toBeInTheDocument();
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('mixed: a warning in force from a live issuer, and the other issuer unavailable', async () => {
        const section = await show('mixed');
        expect(within(section).getAllByRole('article')).toHaveLength(1);
        expect(
            within(section).getByText(/Environment and Climate Change Canada’s warnings unavailable since/),
        ).toBeInTheDocument();
        expect(within(section).getByText(/^Checked .* with National Weather Service \(NOAA\)$/)).toBeInTheDocument();
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('off: the issuer’s feed is not connected yet, with its link (a MeteoAlarm country turned off)', async () => {
        const section = await show('off');
        expect(within(section).getByText('Météo-France (MeteoAlarm)’s feed isn’t connected yet')).toBeInTheDocument();
        // Nothing of MeteoAlarm's is shown, so no disclaimer is owed.
        expect(within(section).queryByTestId('meteoalarm-notice')).toBeNull();
        expect(within(section).getByRole('link', { name: /Open MeteoAlarm warnings/ })).toHaveAttribute(
            'href',
            OFFICIAL_WARNINGS_SOURCES.meteoalarm.url,
        );
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('off in Australia: the Bureau’s feed is not connected yet, with the BoM link', async () => {
        const section = await show('australia');
        expect(within(section).getByText('Bureau of Meteorology’s feed isn’t connected yet')).toBeInTheDocument();
        expect(within(section).getByRole('link', { name: /Open BoM warnings/ })).toHaveAttribute(
            'href',
            OFFICIAL_WARNINGS_SOURCES.bom.url,
        );
    });

    it('none (link-only): no official feed here yet, with the issuer link for the position (New Zealand)', async () => {
        const section = await show('none');
        expect(within(section).getByText('No official feed here yet')).toBeInTheDocument();
        expect(within(section).getByRole('link', { name: /Open MetService warnings/ })).toHaveAttribute(
            'href',
            OFFICIAL_WARNINGS_SOURCES.metservice.url,
        );
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });
});

describe('languages', () => {
    it('reads the block in the reader’s language', async () => {
        setLanguage('en-AU');
        const section = await show('multilang');
        expect(within(section).getByText('gale warning in effect')).toBeInTheDocument();
        expect(within(section).queryByText('avertissement de coup de vent en vigueur')).toBeNull();
        expect(within(section).queryByText(/^In /)).toBeNull();
    });

    it('in French for a French reader', async () => {
        setLanguage('fr-CA');
        const section = await show('multilang');
        expect(within(section).getByText('avertissement de coup de vent en vigueur')).toBeInTheDocument();
        expect(within(section).getByRole('heading', { level: 3 })).toHaveAttribute('lang', 'fr-CA');
    });

    it('takes the reader’s languages in order: en-US then fr-CA reads the English block in Canada', async () => {
        setLanguage('en-US', 'fr-CA');
        const section = await show('multilang');
        expect(within(section).getByText('gale warning in effect')).toBeInTheDocument();
        expect(within(section).queryByText('avertissement de coup de vent en vigueur')).toBeNull();
        expect(within(section).getByRole('heading', { level: 3 })).toHaveAttribute('lang', 'en-CA');
        cleanup();
        // And the other way round for a reader who puts French first.
        setLanguage('fr-FR', 'en-US');
        const fr = await show('multilang');
        expect(within(fr).getByText('avertissement de coup de vent en vigueur')).toBeInTheDocument();
    });

    it('else the issuer’s first block, saying which language it is', async () => {
        setLanguage('de-DE');
        const section = await show('multilang');
        expect(within(section).getByText('avertissement de coup de vent en vigueur')).toBeInTheDocument();
        expect(within(section).getByText(/^In .*French/)).toBeInTheDocument();
    });

    it('right-to-left and non-Latin text as sent, each block marked with its language and direction', async () => {
        setLanguage('en-GB');
        const section = await show('rtl');
        const cards = within(section).getAllByRole('article');
        const [ar, he, ja, el] = FIXTURES.answers.rtl.alerts.map((a) => a.infos);
        // The issuer's words carry its language; the app's own labels stay English.
        expect(within(cards[0]).getByRole('heading', { level: 3 })).toHaveAttribute('lang', 'ar');
        const arabic = within(cards[0]).getByText(ar[0].headline);
        expect(arabic).toHaveAttribute('dir', 'auto');
        expect(arabic).toHaveAttribute('lang', 'ar');
        expect(within(cards[0]).getByTestId('official-description').textContent).toBe(ar[0].description);
        expect(within(cards[0]).getByTestId('official-description')).toHaveAttribute('lang', 'ar');
        expect(within(cards[0]).getByText(/^In Arabic/)).toBeInTheDocument();
        for (const label of [/^Official$/, /^Issued /, /^In Arabic/]) {
            expect(spokenIn(within(cards[0]).getByText(label))).toBe('en');
        }
        expect(cards[0]).not.toHaveAttribute('lang');
        // The Hebrew warning also came in English: the English block is read.
        expect(within(cards[1]).getByText(he[1].headline)).toBeInTheDocument();
        expect(within(cards[1]).queryByText(he[0].headline)).toBeNull();
        expect(within(cards[2]).getByRole('heading', { level: 3 })).toHaveAttribute('lang', 'ja');
        expect(within(cards[2]).getByText(ja[0].headline)).toBeInTheDocument();
        expect(within(cards[3]).getByRole('heading', { level: 3 })).toHaveAttribute('lang', 'el');
        expect(within(cards[3]).getByText(el[0].headline)).toBeInTheDocument();
        // The issuer's own name, in its own script, as sent.
        expect(within(cards[0]).getByText('Fictional Met Service (مصلحة الأرصاد الوهمية)')).toHaveAttribute(
            'dir',
            'auto',
        );
    });
});

describe('a refresh that fails never takes a warning away', () => {
    it('keeps the warnings it had, says it could not check, and never says none is in force', async () => {
        const section = await show('inforce');
        expect(within(section).getAllByRole('article')).toHaveLength(2);
        // Ten minutes on, offshore, the refresh fails.
        rpc.mockImplementation((async () => ({ data: null, error: { message: 'Failed to fetch' } })) as never);
        vi.setSystemTime(new Date(Date.parse(FIXTURES.anchor) + 10 * 60_000));
        const again = await fetchOfficialWarnings(39.1, -76.4);
        expect(again?.alerts).toHaveLength(2);
        expect(again?.staleSince).toBe(FIXTURES.answers.inforce.at);
        cleanup();
        // A page opened now (or the Glass) still has them, marked stale.
        render(<WarningDetails alerts={[]} placeName="Zzbaytown" coordinates={{ lat: 39.1, lon: -76.4 }} />);
        const stale = await screen.findByRole('region', SECTION);
        expect(within(stale).getAllByRole('article')).toHaveLength(2);
        expect(within(stale).getByText(/^Couldn’t reach Thalassa since /)).toBeInTheDocument();
        expect(within(stale).getByRole('link', { name: /Open NWS warnings/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: 'Warnings' })).toBeInTheDocument();
    });

    it('a stale answer that had none in force does not say so', async () => {
        await show('clear');
        rpc.mockImplementation((async () => ({ data: null, error: { message: 'Failed to fetch' } })) as never);
        vi.setSystemTime(new Date(Date.parse(FIXTURES.anchor) + 10 * 60_000));
        cleanup();
        render(<WarningDetails alerts={[]} placeName="Zzbaytown" coordinates={{ lat: 39.1, lon: -76.4 }} />);
        const stale = await screen.findByRole('region', SECTION);
        expect(within(stale).queryByText(/No official warnings/)).toBeNull();
        expect(within(stale).getByText(/^Couldn’t reach Thalassa since /)).toBeInTheDocument();
        // No big green check beside it either.
        expect(screen.getByRole('heading', { level: 3, name: 'No forecast alerts for Zzbaytown' })).toBeInTheDocument();
    });
});

describe('a marine warning just outside its zone, and one outside every listed issuer', () => {
    it('a berth 0.1 NM outside the gale’s marine zone is shown the gale, and told it is for nearby waters', async () => {
        const section = await show('nearby');
        const card = within(section).getByRole('article');
        expect(within(card).getByRole('heading', { level: 3, name: 'Gale Warning' })).toBeInTheDocument();
        expect(within(card).getByText('For the waters within 3 NM of here')).toBeInTheDocument();
        expect(spokenIn(within(card).getByText('For the waters within 3 NM of here'))).toBe('en');
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('credits the issuer of every warning shown, and never says "no feed" beside one', async () => {
        const section = await show('offzone');
        expect(within(section).getAllByRole('article')).toHaveLength(1);
        expect(within(section).getByText('Warnings: National Weather Service (NOAA)')).toBeInTheDocument();
        expect(within(section).queryByText('No official feed here yet')).toBeNull();
        expect(within(section).queryByText(/No official warnings/)).toBeNull();
    });

    it('keeps the issuer’s spaces as sent: an indented line, and a table in columns in a fixed face', async () => {
        const nearby = await show('nearby');
        const text = FIXTURES.answers.nearby.alerts[0].infos[0].description;
        const description = within(nearby).getByTestId('official-description');
        expect(text).toContain('\n  Zz Island');
        expect(description.textContent).toBe(text);
        expect(description.className).toMatch(/\bwhitespace-pre-wrap\b/);
        expect(description.className).not.toMatch(/\bfont-mono\b/);
        cleanup();
        const offzone = await show('offzone');
        const table = within(offzone).getByTestId('official-description');
        expect(table.textContent).toBe(FIXTURES.answers.offzone.alerts[0].infos[0].description);
        expect(table.className).toMatch(/\bwhitespace-pre-wrap\b/);
        expect(table.className).toMatch(/\bfont-mono\b/);
    });

    it('partial: names the newest unplaced warning as anywhere the issuer covers, not as here', async () => {
        const section = await show('partial');
        expect(
            within(section).getByText(
                'Newest not yet placed, anywhere National Weather Service (NOAA) covers: Gale Warning · Fictional Sound out 20 NM',
            ),
        ).toBeInTheDocument();
    });
});

describe('a tapped official push', () => {
    const tapped = (identifier = 'urn:oid:2.49.0.1.840.0.zz0199.001.1', basis = 'home') =>
        pinOfficialPush(
            {
                notification_type: 'official_warning',
                provider: 'nws',
                identifier,
                basis,
                event: 'Gale Warning',
                expires: '2026-10-15T04:00:00Z',
            },
            {
                title: 'Gale Warning',
                body: 'Gale Warning issued October 14 by NWS Zzharbor MD (fictional)\nWarnings: National Weather Service (NOAA)',
            },
        );

    it('on a page set to another place: shown as sent, for the position it was sent for, beside that place’s answer', async () => {
        tapped();
        const section = await show('clear');
        const pin = screen.getByTestId('official-push-pin');
        expect(within(pin).getByRole('heading', { level: 3, name: 'Gale Warning' })).toBeInTheDocument();
        expect(within(pin).getByText('Sent for your home port')).toBeInTheDocument();
        expect(
            within(pin).getByText(/^Not listed for Zzbaytown below\. It may be for other waters/),
        ).toBeInTheDocument();
        expect(
            within(pin).getByText(/^Gale Warning issued October 14 by NWS Zzharbor MD \(fictional\)/).textContent,
        ).toBe(
            'Gale Warning issued October 14 by NWS Zzharbor MD (fictional)\nWarnings: National Weather Service (NOAA)',
        );
        expect(within(pin).getByRole('link', { name: /Open NWS warnings/ })).toBeInTheDocument();
        // It comes first, in the official style; the place's own answer follows, honestly its own.
        expect(pin.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(pin).toHaveAttribute('data-alert-style', 'official');
        expect(screen.getByRole('heading', { level: 1, name: 'Warnings' })).toBeInTheDocument();
        // Taken by the page: a later visit does not show it again.
        expect(peekOfficialPushPin()).toBeNull();
    });

    it('where this place’s answer lists it, its own card is marked instead', async () => {
        tapped(FIXTURES.answers.inforce.alerts[0].identifier, 'fix');
        const section = await show('inforce');
        expect(screen.queryByTestId('official-push-pin')).toBeNull();
        const marked = within(section)
            .getAllByRole('article')
            .filter((a) => a.dataset.pinned === 'true');
        expect(marked).toHaveLength(1);
        expect(within(marked[0]).getByText(/From your notification/)).toBeInTheDocument();
    });

    it('before the place has an answer, the pin shows and the place’s issuer link stays', async () => {
        tapped();
        answering(null, { code: 'PGRST202', message: 'not found' });
        render(<WarningDetails alerts={[]} placeName="Zzbaytown" coordinates={{ lat: -36.84, lon: 174.76 }} />);
        await act(async () => undefined);
        expect(screen.getByTestId('official-push-pin')).toBeInTheDocument();
        expect(screen.queryByRole('region', SECTION)).toBeNull();
        expect(screen.getByRole('link', { name: /Open MetService warnings/ })).toHaveAttribute(
            'href',
            OFFICIAL_WARNINGS_SOURCES.metservice.url,
        );
    });

    it('a MeteoAlarm one carries MeteoAlarm’s disclaimer and www.meteoalarm.org link, as every MeteoAlarm warning shown does', async () => {
        pinOfficialPush(
            {
                notification_type: 'official_warning',
                provider: 'meteoalarm-fr',
                identifier: '2.49.0.0.250.0.FR.ZZ0099',
                basis: 'fix',
                event: 'Orange Coastal Event Warning',
                expires: '2026-10-15T04:00:00Z',
            },
            {
                title: 'Orange Coastal Event Warning',
                body: 'Vagues-submersion zz (texte fictif)\nMétéo-France · Issued 14 Oct, 07:30 CEST · www.meteoalarm.org',
            },
        );
        await show('clear');
        const pin = screen.getByTestId('official-push-pin');
        const notice = within(pin).getByTestId('meteoalarm-notice');
        const disclaimer = within(notice).getByTestId('meteoalarm-disclaimer');
        expect(disclaimer.textContent).toBe(METEOALARM_DISCLAIMER);
        const links = within(disclaimer).getAllByRole('link', { name: 'www.meteoalarm.org' });
        expect(links).toHaveLength(2);
        for (const link of links) expect(link).toHaveAttribute('href', METEOALARM_LINK);
        expect(within(notice).getByText(`Areas: ${METEOALARM_SOURCE}`)).toBeInTheDocument();
    });

    it('an expired one is not shown', async () => {
        tapped();
        vi.setSystemTime(new Date('2026-10-15T05:00:00Z'));
        answering('clear');
        render(<WarningDetails alerts={[]} placeName="Zzbaytown" coordinates={{ lat: 39.1, lon: -76.4 }} />);
        await screen.findByRole('region', SECTION);
        expect(screen.queryByTestId('official-push-pin')).toBeNull();
    });
});

describe('official and "Forecast:" never mix', () => {
    it('each in its own style and its own section', async () => {
        const section = await show('inforce', {
            alerts: ['Forecast: gale-force wind, 34 kt+', 'Forecast: rough seas, 8 ft+ (2.4 m)'],
        });
        const official = [...document.querySelectorAll('[data-alert-style="official"]')];
        const forecast = [...document.querySelectorAll('[data-alert-style="forecast"]')];
        expect(official).toHaveLength(2);
        expect(forecast).toHaveLength(2);
        for (const el of official) {
            expect(section.contains(el)).toBe(true);
            expect(el.className).not.toMatch(/\b(?:bg|border|text)-(?:red|amber|emerald)-/);
            expect(el.textContent).not.toMatch(/Forecast:|Thalassa forecast check/);
        }
        for (const el of forecast) {
            expect(section.contains(el)).toBe(false);
            expect(el.className).not.toMatch(/\b(?:bg|border)-sky-/);
            expect(el.textContent).toMatch(/^.*Forecast:/);
            expect(el.textContent).not.toMatch(/National Weather Service/);
        }
        const officialStyle = new Set(official.map((el) => el.className));
        const forecastStyle = new Set(forecast.map((el) => el.className));
        expect([...officialStyle].some((c) => forecastStyle.has(c))).toBe(false);
    });
});

describe('MeteoAlarm, under its own terms (129-05b)', () => {
    it('a warning as the Style Guide asks: level and type in the title, its source, its area and its times', async () => {
        setLanguage('en-GB');
        const section = await show('meteoalarm');
        const [card] = within(section).getAllByRole('article');
        const [fr, en] = FIXTURES.answers.meteoalarm.alerts[0].infos;
        // Title: the awareness level and type, in the app's English; the issuer's own event as sent.
        const title = within(card).getByRole('heading', { level: 3 });
        expect(title.textContent).toBe('Orange Coastal Event Warning');
        expect(spokenIn(title)).toBe('en');
        expect(within(card).getByText(en.event)).toHaveAttribute('lang', 'en-GB');
        // Source: the national service, never only "MeteoAlarm" (rule 2).
        expect(within(card).getByText('Source: Météo-France')).toBeInTheDocument();
        // The area, as the issuer names it.
        expect(within(card).getByText('Bouches-du-Zzrhône')).toHaveAttribute('dir', 'auto');
        // In effect from onset until expiry, and the time of issue (rule 3), with their time zones.
        expect(within(card).getByText(/^In effect from .+ until .+$/)).toBeInTheDocument();
        expect(within(card).getByText(/^Issued [^·]+$/)).toBeInTheDocument();
        // The impacts, as sent.
        expect(
            within(card).getByText(en.parameters.find((p: { valueName: string }) => p.valueName === 'impacts').value),
        ).toBeInTheDocument();
        // Every language the issuer sent is in the page (the Style Guide): French under "Also issued in".
        const other = within(card).getByText(/^Also issued in French/);
        const block = other.closest('details')!;
        expect(within(block).getByTestId('official-description').textContent).toBe(fr.description);
        expect(spokenIn(within(block).getByTestId('official-description'))).toBe('fr-FR');
        expect(within(block).getByText(fr.instruction)).toBeInTheDocument();
        expect(within(card).getAllByTestId('official-description')[0].textContent).toBe(en.description);
    });

    it('a reader whose language MeteoAlarm did not send reads the English block, as the Style Guide asks', async () => {
        setLanguage('de-DE');
        const section = await show('meteoalarm');
        const [card] = within(section).getAllByRole('article');
        const [fr, en] = FIXTURES.answers.meteoalarm.alerts[0].infos;
        expect(within(card).getByText(en.headline)).toBeInTheDocument();
        expect(
            within(card)
                .getByText(/^Also issued in French/)
                .closest('details'),
        ).toContainElement(within(card).getByText(fr.headline));
    });

    it('the disclaimer, byte for byte, with the www.meteoalarm.org link; the areas credited to EUMETNET', async () => {
        const section = await show('meteoalarm');
        const notice = within(section).getByTestId('meteoalarm-notice');
        const disclaimer = within(notice).getByTestId('meteoalarm-disclaimer');
        expect(disclaimer.textContent).toBe(METEOALARM_DISCLAIMER);
        expect(new TextEncoder().encode(disclaimer.textContent!).join(',')).toBe(
            new TextEncoder().encode(METEOALARM_DISCLAIMER).join(','),
        );
        const links = within(disclaimer).getAllByRole('link', { name: 'www.meteoalarm.org' });
        expect(links).toHaveLength(2);
        for (const link of links) expect(link).toHaveAttribute('href', METEOALARM_LINK);
        fireEvent.click(links[0]);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(METEOALARM_LINK);
        expect(within(notice).getByText(`Areas: ${METEOALARM_SOURCE}`)).toBeInTheDocument();
        // One country: its national service is the source, and "EUMETNET – MeteoAlarm" is not.
        expect(within(notice).queryByText(new RegExp(`^Source: ${METEOALARM_SOURCE}`))).toBeNull();
        expect(within(section).getByRole('link', { name: 'Warnings: Météo-France' })).toHaveAttribute(
            'href',
            METEOALARM_LINK,
        );
        expect(within(section).getByText(/^Checked .* with Météo-France \(MeteoAlarm\)$/)).toBeInTheDocument();
        expect(spokenIn(disclaimer)).toBe('en');
    });

    it('more than one country: "EUMETNET – MeteoAlarm" is the source; a warning for an area within 3 NM says so', async () => {
        setLanguage('en-GB');
        const section = await show('meteoalarm-border');
        const notice = within(section).getByTestId('meteoalarm-notice');
        expect(within(notice).getByText(`Source: ${METEOALARM_SOURCE}`)).toBeInTheDocument();
        expect(within(notice).getByTestId('meteoalarm-disclaimer').textContent).toBe(METEOALARM_DISCLAIMER);
        const [card] = within(section).getAllByRole('article');
        expect(
            within(card).getByText('Source: Servizio Meteorologico dell’Aeronautica Militare (MeteoAM)'),
        ).toBeInTheDocument();
        expect(within(card).getByText('For an area within 3 NM of here')).toBeInTheDocument();
        expect(within(card).queryByText(/For the waters within/)).toBeNull();
    });

    it('an answer with MeteoAlarm in it is asked again every minute, so the page stays in real time (rule 5)', async () => {
        // What the page shows is never more than REALTIME_APP_MS behind the database: a minute's refresh and a
        // cache of 30 seconds (the ingest's rule-5 sum, tests/OfficialAlertsMigration.test.ts, counts on it).
        expect(REALTIME_REFRESH_MS + REALTIME_ANSWER_MS).toBe(REALTIME_APP_MS);
        vi.useFakeTimers({
            shouldAdvanceTime: true,
            toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
        });
        vi.setSystemTime(new Date(FIXTURES.anchor));
        await show('meteoalarm');
        expect(rpc).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(REALTIME_REFRESH_MS);
        });
        expect(rpc).toHaveBeenCalledTimes(2);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(REALTIME_REFRESH_MS);
        });
        expect(rpc).toHaveBeenCalledTimes(3);
        // NWS keeps its 5 minutes: the minute's look finds nothing due.
        cleanup();
        clearOfficialWarningsCache();
        rpc.mockClear();
        await show('inforce');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OFFICIAL_REFRESH_MS - 60_000);
        });
        expect(rpc).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('a MeteoAlarm warning that reaches the database just after another screen asked is on this page within 90 seconds', async () => {
        vi.useFakeTimers({
            shouldAdvanceTime: true,
            toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
        });
        vi.setSystemTime(new Date(FIXTURES.anchor));
        const t0 = Date.now();
        const a = FIXTURES.answers.meteoalarm;
        const fresh = a.alerts[0];
        // The Glass asks first: nothing in force yet. The warning reaches the database a moment later.
        let inDatabase = false;
        rpc.mockImplementation((async () => ({
            data: { ...structuredClone(a), alerts: inDatabase ? [structuredClone(fresh)] : [] },
            error: null,
        })) as never);
        await fetchOfficialWarnings(a.lat, a.lon);
        inDatabase = true;
        // 29 s on, the page opens: the Glass's answer is still in the cache, so it shows none at first.
        vi.setSystemTime(new Date(t0 + REALTIME_ANSWER_MS - 1_000));
        render(<WarningDetails alerts={[]} placeName="Zzport" coordinates={{ lat: a.lat, lon: a.lon }} />);
        const section = await screen.findByRole('region', SECTION);
        expect(within(section).queryAllByRole('article')).toHaveLength(0);
        // Its next look a minute later asks again: shown by 90 s after the database had it.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(REALTIME_REFRESH_MS);
        });
        expect(Date.now() - t0).toBeLessThanOrEqual(REALTIME_APP_MS);
        expect(within(section).getAllByRole('article')).toHaveLength(1);
    });

    it('back in the foreground after a while, it asks again at once', async () => {
        vi.useFakeTimers({
            shouldAdvanceTime: true,
            toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
        });
        vi.setSystemTime(new Date(FIXTURES.anchor));
        // The Marseille fixture uses the official RPC's0.001° position bucket.
        const parameters = { p_lat: 43.297, p_lon: 5.37 };
        const officialCalls = () => rpc.mock.calls.filter(([name]) => name === 'official_alerts_at');
        await show('meteoalarm');
        expect(officialCalls()).toHaveLength(1);
        expect(officialCalls()).toEqual([['official_alerts_at', parameters]]);
        // The app was suspended for 20 minutes (no timer ran); it comes back.
        vi.setSystemTime(new Date(Date.parse(FIXTURES.anchor) + 20 * 60_000));
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(officialCalls()).toHaveLength(2);
        expect(officialCalls()).toEqual([
            ['official_alerts_at', parameters],
            ['official_alerts_at', parameters],
        ]);
    });
});
