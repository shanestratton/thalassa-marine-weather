/**
 * The ONE shared way to ask for the draft (Shane 2026-09-29: "a modal box that
 * says, 'Your draft is set at xxx.xx M. please confirm !!'"): a small store,
 * a single mounted <DraftConfirmModal/>, and requireConfirmedDraft(reason).
 * Real settings store, signed out unless a test signs in.
 */
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile } from '../types/vessel';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { DraftConfirmModal } from '../components/vessel/DraftConfirmModal';
import { getDraftConfirmRequest, requireConfirmedDraft, runWithConfirmedDraft } from '../stores/draftConfirmStore';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { isDraftConfirmed } from '../services/draftConfirmation';
import { FEET_PER_METRE, vesselMaxWaveHeightMetres } from '../services/units';
import { defaultVesselProfile } from '../services/VesselFleetService';

const BOAT: VesselProfile = {
    name: 'Serene Summer',
    type: 'sail',
    length: 40,
    beam: 13,
    draft: 7.87,
    displacement: 20000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
};

function seed(vessel: VesselProfile | undefined, length: 'm' | 'ft' = 'm') {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({
        settings: { ...settings, vessel, vesselUnits: undefined, units: { ...settings.units, length } },
    });
}
const storedVessel = () => useSettingsStore.getState().settings.vessel;

/** Starts an ask and exposes its outcome without awaiting it. */
function ask(reason: Parameters<typeof requireConfirmedDraft>[0] = 'day-plan') {
    const outcome: { value: boolean | undefined } = { value: undefined };
    act(() => {
        void requireConfirmedDraft(reason).then((value) => (outcome.value = value));
    });
    return outcome;
}

const originalPatch = useSettingsStore.getState().patchActiveVesselProfile;

beforeAll(async () => {
    await awaitSettingsLoaded();
});

/** An identity switch reloads settings; seed only after that settles. */
async function signIn(userId: string | null) {
    setAuthIdentityScope(userId);
    await awaitSettingsLoaded();
}

beforeEach(async () => {
    await signIn(null);
    useSettingsStore.setState({ patchActiveVesselProfile: originalPatch, vesselFleet: [], activeVesselId: null });
    seed(BOAT);
});

afterEach(() => {
    cleanup();
});

describe('requireConfirmedDraft + DraftConfirmModal', () => {
    it('asks in one centred dialog; Confirm resolves true, stores the confirmation, and never asks again', async () => {
        render(<DraftConfirmModal />);
        expect(screen.queryByRole('dialog')).toBeNull();
        const outcome = ask();
        const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription('Your draft is set at 2.40 m. Please confirm.');
        expect(dialog).toHaveTextContent('Your draft is set at 2.40 m. Please confirm.');
        expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
        expect(outcome.value).toBeUndefined();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        await waitFor(() => expect(outcome.value).toBe(true));
        expect(screen.queryByRole('dialog')).toBeNull();
        // Feet, as stored: the stored figure itself is confirmed, not a rounded one.
        expect(storedVessel()?.draft).toBe(7.87);
        expect(storedVessel()?.draftConfirmedFt).toBe(7.87);

        // No nagging: the next draft-dependent action runs without a dialog.
        const again = ask('auto-route');
        await waitFor(() => expect(again.value).toBe(true));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows feet too for a skipper whose lengths are in feet', async () => {
        seed(BOAT, 'ft');
        render(<DraftConfirmModal />);
        ask();
        const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(dialog).toHaveTextContent('Your draft is set at 7.87 ft (2.40 m). Please confirm.');
        expect(screen.getByRole('button', { name: 'Confirm 2.40 m' })).toBeInTheDocument();
    });

    it('Change opens a metres field in the modal; bounds give a plain error; Save and confirm writes feet', async () => {
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Change' }));

        const field = screen.getByRole('textbox', { name: 'Draft in metres' });
        expect(field).toHaveAttribute('inputmode', 'decimal');
        expect(field).toHaveValue('2.40');
        await waitFor(() => expect(field).toHaveFocus());

        fireEvent.change(field, { target: { value: '9' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save and confirm' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Enter a draft between 0.30 m and 8.00 m.');
        expect(field).toHaveAttribute('aria-invalid', 'true');
        expect(field).toHaveAccessibleDescription('Enter a draft between 0.30 m and 8.00 m.');
        expect(storedVessel()?.draft).toBe(7.87);
        expect(outcome.value).toBeUndefined();

        fireEvent.change(field, { target: { value: '2.1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save and confirm' }));
        await waitFor(() => expect(outcome.value).toBe(true));
        expect(storedVessel()?.draft).toBeCloseTo(2.1 * FEET_PER_METRE, 10);
        expect(storedVessel()?.draftConfirmedFt).toBe(storedVessel()?.draft);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Back returns from the field to the confirmation without saving', async () => {
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Change' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft in metres' }), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(screen.queryByRole('textbox')).toBeNull();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus());
        expect(storedVessel()?.draft).toBe(7.87);
        expect(outcome.value).toBeUndefined();
    });

    it('with no draft set, says so plainly and shows the field straight away', async () => {
        seed(undefined);
        render(<DraftConfirmModal />);
        const outcome = ask();
        const dialog = await screen.findByRole('dialog', { name: 'Set your draft' });
        expect(dialog).toHaveAccessibleDescription('No draft is set for your boat.');
        const field = screen.getByRole('textbox', { name: 'Draft in metres' });
        expect(field).toHaveValue('');
        await waitFor(() => expect(field).toHaveFocus());
        expect(screen.queryByRole('button', { name: /^Confirm/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

        fireEvent.change(field, { target: { value: '1,8' } });
        // Return on the keypad submits the form.
        fireEvent.submit(field.closest('form')!);
        await waitFor(() => expect(outcome.value).toBe(true));
        expect(storedVessel()?.draft).toBeCloseTo(1.8 * FEET_PER_METRE, 10);
        expect(storedVessel()?.draftConfirmedFt).toBe(storedVessel()?.draft);
    });

    it('an estimated draft says so, and confirming it makes it the skipper’s own', async () => {
        seed({ ...BOAT, estimatedFields: ['draft', 'beam'] });
        render(<DraftConfirmModal />);
        const outcome = ask();
        const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(dialog).toHaveTextContent('This is an estimate, not a measurement.');
        // VoiceOver hears it too, before the one tap that makes a guess the skipper's own.
        expect(dialog).toHaveAccessibleDescription(
            'Your draft is set at 2.40 m. Please confirm. This is an estimate, not a measurement.',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        await waitFor(() => expect(outcome.value).toBe(true));
        expect(storedVessel()?.estimatedFields).toEqual(['beam']);
        expect(storedVessel()?.draftConfirmedFt).toBe(7.87);
    });

    // Review 2026-09-29: the bounds guarded only the field. A draft entered as
    // 0.8 while the Vessel tab was in feet is 0.24 m, and 'Confirm 0.24 m' was
    // one tap away. Too shallow is the unsafe way round: the minimum charted
    // depth is the draft + 0.5 m.
    it('never offers to confirm a stored draft outside the sensible range: it asks for it again', async () => {
        for (const [ft, shown] of [
            [0.8, '0.24 m'],
            [30, '9.14 m'],
        ] as const) {
            seed({ ...BOAT, draft: ft });
            render(<DraftConfirmModal />);
            const outcome = ask();
            const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
            expect(dialog).toHaveAccessibleDescription(
                `Your draft is set at ${shown}, which looks wrong. Enter it in metres.`,
            );
            expect(screen.queryByRole('button', { name: /^Confirm/ })).toBeNull();
            const field = screen.getByRole('textbox', { name: 'Draft in metres' });
            fireEvent.change(field, { target: { value: '2.4' } });
            fireEvent.submit(field.closest('form')!);
            await waitFor(() => expect(outcome.value).toBe(true));
            expect(storedVessel()?.draftConfirmedFt).toBe(storedVessel()?.draft);
            expect((storedVessel()?.draft ?? 0) / FEET_PER_METRE).toBeCloseTo(2.4, 6);
            cleanup();
        }
    });

    it('a changed draft is asked about again', async () => {
        seed({ ...BOAT, draft: 8.2, draftConfirmedFt: 7.87 });
        render(<DraftConfirmModal />);
        ask();
        expect(await screen.findByRole('dialog', { name: 'Check your draft' })).toHaveTextContent(
            'Your draft is set at 2.50 m. Please confirm.',
        );
    });

    it.each([
        ['Close', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
        ['Escape', () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })],
        ['the backdrop', () => fireEvent.click(screen.getByRole('dialog', { name: 'Check your draft' }))],
    ])('closing with %s resolves false and changes nothing', async (_name, close) => {
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Check your draft' });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
        close();
        await waitFor(() => expect(outcome.value).toBe(false));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(storedVessel()).toEqual(BOAT);
        expect(getDraftConfirmRequest()).toBeNull();
    });

    it('Cancel with no draft set resolves false', async () => {
        seed(undefined);
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Set your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(outcome.value).toBe(false));
        expect(storedVessel()).toBeUndefined();
    });

    it('two asks at once share one dialog and one answer', async () => {
        render(<DraftConfirmModal />);
        const first = ask('departure-sweep');
        const second = ask('departure-sweep');
        await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        await waitFor(() => expect([first.value, second.value]).toEqual([true, true]));
    });

    it('runWithConfirmedDraft runs at once when confirmed, and only after Confirm otherwise', async () => {
        render(<DraftConfirmModal />);
        const action = vi.fn();
        seed({ ...BOAT, draftConfirmedFt: 7.87 });
        runWithConfirmedDraft('charted-leads', action);
        expect(action).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();

        seed(BOAT);
        act(() => runWithConfirmedDraft('charted-leads', action));
        await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(action).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        await waitFor(() => expect(action).toHaveBeenCalledTimes(2));

        seed(BOAT);
        act(() => runWithConfirmedDraft('charted-leads', action));
        await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(getDraftConfirmRequest()).toBeNull());
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('signed in, it saves through the fleet patch like the Vessel tab does', async () => {
        await signIn('draft-skipper');
        seed({ ...BOAT, estimatedFields: ['draft'] });
        const patch = vi.fn((input: { profile: Partial<VesselProfile> }) => {
            const settings = useSettingsStore.getState().settings;
            useSettingsStore.setState({ settings: { ...settings, vessel: { ...settings.vessel!, ...input.profile } } });
            return Promise.resolve();
        });
        useSettingsStore.setState({ patchActiveVesselProfile: patch as never });
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        await waitFor(() => expect(outcome.value).toBe(true));
        expect(patch).toHaveBeenCalledWith({ profile: { draftConfirmedFt: 7.87, estimatedFields: [] } });
    });

    it('a save that does not land keeps the dialog open with a plain error', async () => {
        await signIn('draft-skipper');
        seed(BOAT);
        useSettingsStore.setState({
            patchActiveVesselProfile: (() => Promise.reject(new Error('offline'))) as never,
        });
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Check your draft' });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm 2.40 m' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Your draft was not saved. Try again.');
        expect(outcome.value).toBeUndefined();
        expect(screen.getByRole('dialog', { name: 'Check your draft' })).toBeInTheDocument();
    });

    it('with no modal mounted nothing runs (the ask never passes silently)', async () => {
        const outcome = ask();
        await waitFor(() => expect(outcome.value).toBe(false));
    });

    it('house rules: centred, clear of the tab bar, internal scroll, 44 px targets', async () => {
        render(<DraftConfirmModal />);
        ask();
        const dialog = await screen.findByRole('dialog', { name: 'Check your draft' });
        expect(dialog.className).toMatch(/\bitems-center\b/);
        expect(dialog.className).toMatch(/\bjustify-center\b/);
        expect(dialog.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        const card = dialog.firstElementChild as HTMLElement;
        expect(card.className).toContain('max-h-full');
        expect(card.className).toContain('overflow-y-auto');
        for (const button of screen.getAllByRole('button')) expect(button.className).toMatch(/min-h-\[44px\]|h-11/);
        fireEvent.click(screen.getByRole('button', { name: 'Change' }));
        expect(screen.getByRole('textbox', { name: 'Draft in metres' }).className).toContain('min-h-11');
    });
});

/**
 * Review 2026-09-29: a punter with no boat profile plans on DEFAULT_VESSEL.
 * Saving only a draft from 'Set your draft' made a boat of zeros — the
 * planner then refused ("Set a valid cruising speed"), the departure window
 * capped waves at 0 m, and the next sign-in bootstrapped that boat to the
 * cloud. With no boat behind the draft, the save carries the Vessel tab's own
 * starting figures, marked as guesses.
 */
describe('a draft saved with no boat behind it', () => {
    const GUESSED = ['beam', 'cruisingSpeed', 'displacement', 'length', 'maxWaveHeight'];

    async function saveDraftFromModal(metres: string) {
        render(<DraftConfirmModal />);
        const outcome = ask();
        await screen.findByRole('dialog', { name: 'Set your draft' });
        fireEvent.change(screen.getByRole('textbox', { name: 'Draft in metres' }), { target: { value: metres } });
        fireEvent.click(screen.getByRole('button', { name: 'Save and confirm' }));
        await waitFor(() => expect(outcome.value).toBe(true));
    }

    /** Stands in for the store's patchActiveVesselProfile: applies the patch
     *  the way applyPatchLocally does (a missing profile starts from
     *  defaultVesselProfile()), which is also what a first bootstrap sends. */
    function fakeFleetPatch() {
        const patch = vi.fn((input: { profile: Partial<VesselProfile> }) => {
            const settings = useSettingsStore.getState().settings;
            useSettingsStore.setState({
                settings: {
                    ...settings,
                    vessel: { ...(settings.vessel ?? defaultVesselProfile()), ...input.profile },
                },
            });
            return Promise.resolve();
        });
        useSettingsStore.setState({ patchActiveVesselProfile: patch as never });
        return patch;
    }

    function expectGuessedBoat(vessel: Partial<VesselProfile> | undefined, name: string) {
        // Never a boat of zeros.
        expect(vessel?.cruisingSpeed).toBeGreaterThan(0);
        expect(vessel?.maxWaveHeight).toBeGreaterThan(0);
        expect(vesselMaxWaveHeightMetres(vessel)).toBeGreaterThan(0);
        // The Vessel tab's starting figures (feet, knots, lbs), marked as guesses.
        expect(vessel).toMatchObject({
            name,
            type: 'sail',
            length: 30,
            beam: 10,
            displacement: 10000,
            maxWaveHeight: 6,
            cruisingSpeed: 6,
        });
        expect([...(vessel?.estimatedFields ?? [])].sort()).toEqual(GUESSED);
        // The draft is the skipper's own, and confirmed.
        expect(vessel?.draft).toBeCloseTo(1.8 * FEET_PER_METRE, 10);
        expect(isDraftConfirmed(vessel)).toBe(true);
    }

    it('signed out, no vessel profile: the saved boat has the Vessel tab’s guesses, not zeros', async () => {
        seed(undefined);
        await saveDraftFromModal('1.80');
        expectGuessedBoat(storedVessel(), 'My Boat');
    });

    it('signed in, no vessel profile: the fleet patch carries the whole guessed boat, so no boat of zeros is bootstrapped', async () => {
        await signIn('draft-skipper');
        seed(undefined);
        const patch = fakeFleetPatch();
        await saveDraftFromModal('1.80');
        expect(patch).toHaveBeenCalledTimes(1);
        expectGuessedBoat(patch.mock.calls[0][0].profile, 'My Boat');
        expectGuessedBoat(storedVessel(), 'My Boat');
    });

    it('the released-hull placeholder (My Boat, all zeros) gets the same guesses', async () => {
        seed(defaultVesselProfile('My Boat'));
        await saveDraftFromModal('1.80');
        expectGuessedBoat(storedVessel(), 'My Boat');
    });

    it('a boat with figures but no draft keeps every figure it has: only the draft is saved', async () => {
        const noDraft: VesselProfile = { ...BOAT, draft: 0, cruisingSpeed: 7, estimatedFields: ['beam'] };
        seed(noDraft);
        await saveDraftFromModal('1.80');
        const saved = storedVessel();
        expect(saved).toEqual({ ...noDraft, draft: saved?.draft, draftConfirmedFt: saved?.draft });
        expect(saved?.draft).toBeCloseTo(1.8 * FEET_PER_METRE, 10);
    });

    it('signed in, a real boat with no draft: the fleet patch is the draft alone', async () => {
        await signIn('draft-skipper');
        seed({ ...BOAT, draft: 0 });
        const patch = fakeFleetPatch();
        await saveDraftFromModal('1.80');
        const draftFt = 1.8 * FEET_PER_METRE;
        expect(patch).toHaveBeenCalledWith({ profile: { draft: draftFt, draftConfirmedFt: draftFt } });
    });

    it('signed in, the selected fleet boat is what counts when the local copy is missing: her figures are never overwritten', async () => {
        await signIn('draft-skipper');
        seed(undefined);
        useSettingsStore.setState({
            vesselFleet: [{ id: 'boat-a', profile: { ...BOAT, draft: 0 }, is_active: true } as never],
            activeVesselId: 'boat-a',
        });
        const patch = fakeFleetPatch();
        await saveDraftFromModal('1.80');
        const draftFt = 1.8 * FEET_PER_METRE;
        expect(patch).toHaveBeenCalledWith({ profile: { draft: draftFt, draftConfirmedFt: draftFt } });
    });
});

describe('one modal, mounted once', () => {
    function sourceFiles(dir: string): string[] {
        return readdirSync(dir).flatMap((name) => {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) return sourceFiles(path);
            return /\.(ts|tsx)$/.test(name) ? [path] : [];
        });
    }

    it('App mounts the single DraftConfirmModal and nothing else renders one', () => {
        const app = readFileSync('App.tsx', 'utf8');
        expect(app.match(/<DraftConfirmModal\s*\/>/g)).toHaveLength(1);
        const renderers = [...sourceFiles('components'), ...sourceFiles('pages')].filter(
            (file) =>
                !file.endsWith(join('vessel', 'DraftConfirmModal.tsx')) &&
                /<DraftConfirmModal\b/.test(readFileSync(file, 'utf8')),
        );
        expect(renderers).toEqual([]);
    });
});
