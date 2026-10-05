/**
 * The quick log sheet: one tap logs, then everything edits the saved
 * sighting. Fictional people and boats only: Wren Hollis skippers the
 * Kittiwake Run; Tamsin Reyes is her crew.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/supabase', () => ({ supabase: null }));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/sightings/photoStrip', () => ({
    stripAndCompressPhoto: async (file: Blob) => file,
    PhotoStripError: class extends Error {},
}));
const drains = vi.hoisted(() => ({ schedule: vi.fn(), ensure: vi.fn() }));
vi.mock('../../services/sightings/sightingSync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../services/sightings/sightingSync')>()),
    scheduleSightingDrain: drains.schedule,
    ensureSightingSyncTriggers: drains.ensure,
}));
const sessionBox = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../hooks/sightings/useSightingsSession', () => ({
    useSightingsSession: () => sessionBox.current,
}));

import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { parseCatalogue } from '../../services/sightings/catalogue';
import type { SightingContext } from '../../services/sightings/sightingContext';
import { listLocalSightings, memoryBackend, setSightingStoreBackend } from '../../services/sightings/sightingStore';
import {
    QuickLogSheet,
    contextChips,
    crewAudience,
    forecastNote,
    type QuickLogDeps,
} from '../../components/sightings/QuickLogSheet';
import { forecastCredit } from '../../components/sightings/sightingsFormat';
import type { SightingsSession } from '../../hooks/sightings/useSightingsSession';

const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const TAMSIN = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const KITTIWAKE_RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const OPENED_AT = Date.parse('2026-10-05T04:32:00Z');

const catalogue = parseCatalogue(
    JSON.parse(readFileSync(resolve(process.cwd(), 'data/sightings/species-qld-gbr.v1.json'), 'utf8')),
);

function ctx(over: Partial<SightingContext> = {}, lat = -20.2567, lon = 148.9512): SightingContext {
    return {
        capturedAt: OPENED_AT,
        position: {
            latitude: lat,
            longitude: lon,
            source: 'pi',
            fixAt: OPENED_AT,
            accuracyM: 10,
            uncertaintyM: 12,
            ashore: false,
        },
        boatSilent: false,
        samplingProtocol: 'opportunistic vessel-based observation',
        seaTempC: 24.1,
        seaTempSource: 'instrument',
        waterDepthM: 18.4,
        depthReference: 'below-keel',
        windSpeedKts: 14,
        windDirDeg: 135,
        windSource: 'instrument',
        waveHeightM: null,
        wxModel: null,
        sogKts: 6.2,
        cogDeg: 42,
        headingDeg: null,
        ...over,
    };
}

function session(over: Partial<SightingsSession> = {}): SightingsSession {
    return {
        userId: WREN,
        ownBoatId: KITTIWAKE_RUN,
        ownBoatName: 'Kittiwake Run',
        crewing: null,
        crewVessels: [],
        ownCrewCount: 2,
        ...over,
    };
}

function deps(context: SightingContext | null = ctx()): Partial<QuickLogDeps> {
    return {
        captureContext: () => (context ? Promise.resolve(context) : Promise.reject(new Error('no fix'))),
        loadCatalogue: () => Promise.resolve(catalogue),
        resolveRecording: () => Promise.resolve({ voyageId: 'voyage_1759638000000_ab12', boatId: KITTIWAKE_RUN }),
        observerDisplay: () => Promise.resolve('Wren'),
    };
}

async function openSheet(d = deps(), onClose = vi.fn(), onLogged = vi.fn()) {
    const view = render(<QuickLogSheet openedAt={OPENED_AT} onClose={onClose} onLogged={onLogged} deps={d} />);
    await screen.findByRole('dialog', { name: 'What did you see?' });
    return { view, onClose, onLogged };
}

async function tap(name: string, role: 'button' | 'radio' = 'button') {
    await act(async () => {
        fireEvent.click(screen.getByRole(role, { name }));
    });
}

beforeEach(() => {
    setSightingStoreBackend(memoryBackend());
    setAuthIdentityScope(WREN);
    sessionBox.current = session();
    drains.schedule.mockClear();
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('step 1: what did you see?', () => {
    it('offers the eight groups as big named tiles and says where the position comes from', async () => {
        await openSheet();
        const grid = screen.getByRole('group', { name: 'Log a group' });
        const tiles = within(grid).getAllByRole('button');
        expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
            'Log whale',
            'Log dolphin',
            'Log dugong',
            'Log turtle',
            'Log seabird',
            'Log shark or ray',
            'Log fish',
            'Log other',
        ]);
        expect(await screen.findByText('Boat GPS (via Pi)')).toBeInTheDocument();
        expect(screen.getByText(/20°15\.4′S 148°57\.1′E/)).toBeInTheDocument();
        // VoiceOver and keyboards start at the heading; no tile looks pre-chosen.
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'What did you see?' }));
    });

    it('says, BEFORE the tap, that the phone stands in when the boat GPS is silent', async () => {
        const silent = ctx({ boatSilent: true });
        silent.position!.source = 'phone';
        await openSheet(deps(silent));
        expect(await screen.findByText('Boat GPS isn’t answering.')).toBeInTheDocument();
        expect(screen.getByText(/marked as phone GPS/)).toBeInTheDocument();
    });

    it('closes without logging anything', async () => {
        const { onClose } = await openSheet();
        fireEvent.click(screen.getByRole('button', { name: 'Close without logging' }));
        expect(onClose).toHaveBeenCalled();
        expect(await listLocalSightings(WREN)).toHaveLength(0);
    });

    it('Escape closes it too (keyboard users)', async () => {
        const { onClose } = await openSheet();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });
});

describe('one tap logs', () => {
    it('saves the sighting at once, timed when the sheet opened, against the recording voyage', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        expect(await screen.findByRole('dialog', { name: 'Whale logged' })).toBeInTheDocument();
        const [saved] = await listLocalSightings(WREN);
        expect(saved.row).toMatchObject({
            taxon_group: 'whale',
            event_date: new Date(OPENED_AT).toISOString(),
            vessel_owner_id: WREN,
            boat_id: KITTIWAKE_RUN,
            voyage_id: 'voyage_1759638000000_ab12',
            // The skipper has crew: the first default is Crew, never Public.
            visibility: 'crew',
            decimal_latitude: -20.2567,
            position_source: 'pi',
            sea_temp_c: 24.1,
            observer_display: 'Wren',
        });
        // Not on the server yet: the crew see it once it is sent, not "now".
        expect(screen.getByText(/you and your 2 crew on the Kittiwake Run see it once it’s sent/)).toBeInTheDocument();
        expect(screen.getByText('Sea 24.1 °C')).toBeInTheDocument();
        expect(screen.getByText('Wind 14 kn SE')).toBeInTheDocument();
    });

    it('defaults to Private on a boat with nobody else aboard', async () => {
        sessionBox.current = session({ ownCrewCount: 0 });
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log turtle');
        await screen.findByRole('dialog', { name: 'Turtle logged' });
        const [saved] = await listLocalSightings(WREN);
        expect(saved.row.visibility).toBe('private');
        expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
    });

    it('shows the verified approach distances for a whale in Queensland, and lights the calf rows', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        const card = await screen.findByTestId('distance-card');
        expect(within(card).getByText('Keep your distance')).toBeInTheDocument();
        expect(within(card).getAllByText('100 m')).toHaveLength(1);
        expect(within(card).getAllByText('300 m')).toHaveLength(2);
        expect(within(card).getByText(/Your boat from any whale/)).toBeInTheDocument();
        // Whitsundays: the Whale Protection Area line is promoted to the top.
        expect(within(card).getAllByRole('listitem')[0]).toHaveTextContent('Whitsundays Whale Protection Area');
        expect(within(card).getByRole('button', { name: /Queensland Government/ })).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: /GBRMPA/ })).toBeInTheDocument();
        // Four rules first (the boat, the calf, the speed); the rest behind one tap.
        expect(within(card).getAllByRole('listitem')).toHaveLength(4);
        expect(card).not.toHaveTextContent('Migaloo');
        await tap('2 more rules');
        expect(within(card).getAllByRole('listitem')).toHaveLength(6);
        expect(card).toHaveTextContent('From a white humpback such as Migaloo');
        expect(card).toHaveTextContent('No one in or entering the water');
        expect(card).toHaveTextContent('checked 5 Oct 2026');
        expect(card.querySelector('[data-calf="lit"]')).toBeNull();
        await tap('Calf with them');
        expect(screen.getByRole('button', { name: 'Calf with them' })).toHaveAttribute('aria-pressed', 'true');
        expect(card.querySelector('[data-calf="lit"]')).toHaveTextContent('From a whale calf');
        expect((await listLocalSightings(WREN))[0].row.has_calf).toBe(true);
    });

    it('gives no number outside Queensland: keep your distance, check the local rules', async () => {
        await openSheet(deps(ctx({}, -33.85, 151.3)));
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log dolphin');
        const card = await screen.findByTestId('distance-card');
        expect(card).toHaveTextContent('check the local rules');
        expect(card).not.toHaveTextContent(/\d+ m/);
        expect(within(card).getByRole('button', { name: /National Guidelines/ })).toBeInTheDocument();
    });

    it('draws no distance card for turtles, seabirds or fish', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log seabird');
        await screen.findByRole('dialog', { name: 'Seabird logged' });
        expect(screen.queryByTestId('distance-card')).toBeNull();
    });

    it('refines the species from the likely chips, and back to group only', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        await tap('Humpback whale');
        await screen.findByRole('dialog', { name: 'Humpback whale logged' });
        let [saved] = await listLocalSightings(WREN);
        expect(saved.row.scientific_name).toBe('Megaptera novaeangliae');
        expect(saved.vernacularName).toBe('Humpback whale');
        await tap('Humpback whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        [saved] = await listLocalSightings(WREN);
        expect(saved.row.scientific_name).toBeNull();
    });

    it('counts with 48 px steppers and never below one', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log dolphin');
        const fewer = await screen.findByRole('button', { name: 'One fewer' });
        expect(fewer).toBeDisabled();
        expect(fewer.className).toContain('sg-step');
        await tap('One more');
        await tap('One more');
        expect((await listLocalSightings(WREN))[0].row.individual_count).toBe(3);
        expect(screen.getByRole('group', { name: 'How many?' })).toHaveTextContent('3');
    });

    it('never offers Public for fish: catch spots are yours', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log fish');
        await screen.findByRole('dialog', { name: 'Fish logged' });
        // Private by default even on a boat with crew (a whale here starts Crew).
        expect((await listLocalSightings(WREN))[0].row.visibility).toBe('private');
        expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: 'Crew' })).not.toHaveAttribute('aria-disabled');
        const pub = screen.getByRole('radio', { name: 'Public' });
        expect(pub).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(pub);
        expect((await listLocalSightings(WREN))[0].row.visibility).not.toBe('public');
        expect(screen.getByText('Fish stay off the public map. Catch spots are yours.')).toBeInTheDocument();
    });

    it('explains Public: three hours late, blurred, photos stay with the crew; credit is opt-in', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        await tap('Public', 'radio');
        expect(screen.getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-checked', 'true');
        // Group only: the 8 km grid until the species is named, and no log-handle credit there.
        expect(screen.getByText(/blurred to about 8 km until you name the species/)).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /Credit my public log handle/ })).toBeNull();
        expect(screen.getByText(/No log-handle credit on the 8 km grid/)).toBeInTheDocument();
        // A humpback is not threatened: 1 km, and credit may be ticked.
        await tap('Humpback whale');
        await screen.findByRole('dialog', { name: 'Humpback whale logged' });
        expect(screen.getByText(/Everyone, 3 hours later, blurred to about 1 km/)).toBeInTheDocument();
        const credit = screen.getByRole('checkbox', { name: /Credit my public log handle/ });
        expect(credit).not.toBeChecked();
        await act(async () => {
            fireEvent.click(credit);
        });
        const [saved] = await listLocalSightings(WREN);
        expect(saved.row).toMatchObject({ visibility: 'public', credit_public: true });
    });

    it('moves between who-sees-it options with the arrow keys (one radio group)', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        const group = screen.getByRole('radiogroup', { name: 'Who sees it' });
        const crew = within(group).getByRole('radio', { name: 'Crew' });
        expect(crew).toHaveAttribute('tabindex', '0');
        await act(async () => {
            fireEvent.keyDown(crew, { key: 'ArrowRight' });
        });
        await waitFor(() =>
            expect(within(group).getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-checked', 'true'),
        );
    });

    it('Undo, in the footer beside Done, removes it and goes back to the groups', async () => {
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        const dialog = await screen.findByRole('dialog', { name: 'Whale logged' });
        const undo = within(dialog).getByRole('button', { name: 'Undo' });
        const done = within(dialog).getByRole('button', { name: 'Done' });
        // Same footer row as Done, never in the header corner.
        expect(undo.parentElement).toBe(done.parentElement);
        expect(dialog.querySelector('header')?.contains(undo)).toBe(false);
        await tap('Undo');
        expect(await screen.findByRole('dialog', { name: 'What did you see?' })).toBeInTheDocument();
        expect(await listLocalSightings(WREN)).toHaveLength(0);
    });

    it('the top-right corner saves and closes after the tap: a reflex dismiss never loses the whale', async () => {
        const { onClose, onLogged } = await openSheet();
        // Step 1's corner closes without logging...
        expect(screen.getByRole('button', { name: 'Close without logging' })).toBeInTheDocument();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        const dialog = await screen.findByRole('dialog', { name: 'Whale logged' });
        // ...and after the tap the same corner saves.
        const corner = within(dialog.querySelector('header') as HTMLElement).getByRole('button');
        expect(corner).toHaveAccessibleName('Save and close');
        await act(async () => {
            fireEvent.click(corner);
        });
        expect(onClose).toHaveBeenCalled();
        const saved = await listLocalSightings(WREN);
        expect(saved).toHaveLength(1);
        expect(onLogged).toHaveBeenCalledWith(saved[0].id);
    });

    it("asks for this boat's cloud row, and never logs at another boat's", async () => {
        const owners: unknown[] = [];
        // Wren owns the Kittiwake Run and crews for Odo: the sheet's first fix
        // came from Odo's row (the session was still loading).
        const odosRow = ctx({
            position: { ...ctx().position!, source: 'cloud', cloudOwner: 'f0e1d2c3-b4a5-4968-8776-655443322110' },
        });
        let first = true;
        const d: Partial<QuickLogDeps> = {
            ...deps(),
            captureContext: async (owner) => {
                owners.push(await owner?.());
                if (first) {
                    first = false;
                    return odosRow;
                }
                return ctx({ position: { ...ctx().position!, source: 'cloud', cloudOwner: 'self', latitude: -20.3 } });
            },
        };
        await openSheet(d);
        await screen.findByText('Boat GPS (via cloud)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        await waitFor(async () => expect((await listLocalSightings(WREN))[0].row.decimal_latitude).toBe(-20.3));
        // Her own boat both times: 'self'.
        expect(owners).toEqual(['self', 'self']);
    });

    it('Done sends it now and closes', async () => {
        const { onClose, onLogged } = await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        drains.schedule.mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(drains.schedule).toHaveBeenCalledWith(0);
        expect(onLogged).toHaveBeenCalledWith((await listLocalSightings(WREN))[0].id);
        expect(onClose).toHaveBeenCalled();
    });

    it('keeps a sighting with no fix as "needs a position" and offers Retry', async () => {
        let fix = ctx({ position: null });
        const d = { ...deps(), captureContext: () => Promise.resolve(fix) };
        await openSheet(d);
        expect(await screen.findByText('No position yet.')).toBeInTheDocument();
        await tap('Log dugong');
        await screen.findByRole('dialog', { name: 'Dugong logged' });
        expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
        // It does not send itself: it waits, unsent, until it has a position.
        expect(screen.getByText(/It stays on this phone, unsent, until it has one/)).toBeInTheDocument();
        expect((await listLocalSightings(WREN))[0].sync.state).toBe('needs-position');
        fix = ctx(); // the boat's GPS comes back
        await tap('Retry');
        await waitFor(async () => expect((await listLocalSightings(WREN))[0].sync.state).toBe('pending'));
        expect((await listLocalSightings(WREN))[0].row.decimal_latitude).toBe(-20.2567);
    });
});

describe('signed out', () => {
    it('still logs, Private and on this phone only', async () => {
        setAuthIdentityScope(null);
        sessionBox.current = session({ userId: null, ownBoatId: null, ownBoatName: null, ownCrewCount: null });
        await openSheet();
        await screen.findByText('Boat GPS (via Pi)');
        await tap('Log whale');
        await screen.findByRole('dialog', { name: 'Whale logged' });
        const [saved] = await listLocalSightings(null);
        expect(saved.row).toMatchObject({ visibility: 'private', observer_id: null, vessel_owner_id: null });
        expect(screen.getByRole('radio', { name: 'Crew' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByText(/Only you, on this phone/)).toBeInTheDocument();
        expect(screen.getByText(/on this phone only/)).toBeInTheDocument();
    });
});

describe('words', () => {
    it('names who a Crew sighting reaches', () => {
        const s = session();
        expect(crewAudience(s, WREN)).toBe('you and your 2 crew on the Kittiwake Run');
        expect(crewAudience({ ...s, ownCrewCount: 0 }, WREN)).toBe('anyone you add as crew on the Kittiwake Run');
        expect(
            crewAudience(
                {
                    ...s,
                    crewVessels: [{ ownerId: TAMSIN, vesselName: 'Sea Pippin', role: 'deckhand', lastAcceptedAt: '' }],
                },
                TAMSIN,
            ),
        ).toBe('the skipper and crew of the Sea Pippin');
    });

    it('turns the context into short chips, wind by where it comes from', () => {
        const row = {
            sea_temp_c: 24.12,
            water_depth_m: 18.44,
            wind_speed_kts: 13.6,
            wind_dir_deg: 135,
            wave_height_m: 1.24,
            sog_kts: 6.2,
            cog_deg: 42,
        } as Parameters<typeof contextChips>[0];
        expect(contextChips(row)).toEqual([
            'Sea 24.1 °C',
            'Depth 18.4 m',
            'Wind 14 kn SE',
            'Waves 1.2 m',
            '6.2 kn · 042°',
        ]);
    });

    it('credits forecast values to the agency that made them (CC-BY), never a bare source tag', () => {
        expect(forecastCredit('openmeteo_ecmwf_ifs025')).toBe('Forecast data: ECMWF');
        expect(forecastCredit('wx_dwd_icon')).toBe('Forecast data: DWD');
        expect(forecastCredit('stormglass_gfs+fallback:icon')).toBe('Forecast data: DWD, NOAA, StormGlass');
        expect(forecastCredit('wk+sg')).toBe('Forecast data: Apple Weather, StormGlass');
        expect(forecastCredit('somethingnew')).toBe('Forecast data: somethingnew');
        expect(forecastCredit(null)).toBe('Forecast data');
        const row = {
            sea_temp_c: 24.1,
            sea_temp_source: 'instrument',
            wind_speed_kts: 14,
            wind_source: 'forecast',
            wave_height_m: 1.2,
            wx_model: 'openmeteo_ecmwf_ifs025',
        } as Parameters<typeof forecastNote>[0];
        expect(forecastNote(row)).toBe('Wind and waves from the forecast. Forecast data: ECMWF');
        expect(forecastNote({ ...row, wind_source: 'instrument', wave_height_m: null })).toBeNull();
    });
});
