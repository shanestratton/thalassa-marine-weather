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
import { WarningDetails } from '../components/WarningDetails';
import { clearOfficialWarningsCache, fetchOfficialWarnings } from '../services/officialWarnings';
import { pinOfficialPush, peekOfficialPushPin, takeOfficialPushPin } from '../services/officialPushPin';
import { OFFICIAL_WARNINGS_SOURCES } from '../utils/officialWarningsSource';

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

    it('off: the issuer’s feed is not connected yet, with its link (Europe until MeteoAlarm confirms)', async () => {
        const section = await show('off');
        expect(within(section).getByText('MeteoAlarm (France)’s feed isn’t connected yet')).toBeInTheDocument();
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
