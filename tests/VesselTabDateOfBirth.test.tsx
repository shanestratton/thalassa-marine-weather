/**
 * Settings → Vessel Profile → Crew asks for a date of birth, not an age
 * (129-14, Shane 2026-10-14: "in the vessel profile, can we change punters age
 * for date of birth. Otherwise we will have to change the age every year").
 *
 * The same rows are an invitee's own details: on their own profile they are
 * the Skipper row, and that row goes to their skipper's float plan. The field
 * is the platform's own date picker, so the date shows in the phone's own
 * locale format; it is stored as yyyy-mm-dd with no time and no zone. The age
 * it gives today shows beside it. An age typed before 129 stays, with a gentle
 * note, until a date of birth is entered. Fictional people only.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ store: { settings: {} } as Record<string, unknown> }));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(mocks.store), {
        getState: () => mocks.store,
    }),
}));
vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => ({ reachable: false, lastCheck: 0, latencyMs: 0 }),
        ping: vi.fn(async () => ({ reachable: false, lastCheck: 0, latencyMs: 0 })),
    },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => null }));
vi.mock('../services/VesselIdentityService', () => ({ saveIdentity: vi.fn() }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => 0 }));
vi.mock('../components/settings/YachtDatabaseSearch', () => ({ YachtDatabaseSearch: () => null }));

import { VesselTab } from '../components/settings/VesselTab';
import type { UserSettings } from '../types';
import type { VesselCrewPerson } from '../types/vessel';

function settingsWith(crewRoster: VesselCrewPerson[]): UserSettings {
    return {
        units: { speed: 'kts', length: 'm', distance: 'nm', temp: 'C', waveHeight: 'm' },
        vesselUnits: { length: 'm', beam: 'm', draft: 'm', displacement: 'kg' },
        vessel: {
            name: 'Southerly Spirit',
            type: 'sail',
            length: 46,
            beam: 14,
            draft: 6.9,
            displacement: 9000,
            maxWaveHeight: 0,
            cruisingSpeed: 0,
            crewCount: 2,
            crewRoster,
        },
    } as unknown as UserSettings;
}

const dateField = (who: string) => screen.getByLabelText(`${who} date of birth`) as HTMLInputElement;
const savedRoster = (onSave: ReturnType<typeof vi.fn>) =>
    onSave.mock.lastCall?.[0]?.vessel?.crewRoster as VesselCrewPerson[] | undefined;

const zone = process.env.TZ;
beforeEach(() => {
    mocks.store.settings = {};
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
});
afterEach(() => {
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
});

describe('VesselTab: date of birth instead of age', () => {
    it("asks each person's date of birth with the platform's own date picker, and no age box", () => {
        render(
            <VesselTab
                settings={settingsWith([{ name: 'Ingrid Solberg', rank: 'Skipper' }, { name: '' }])}
                onSave={vi.fn()}
            />,
        );
        for (const who of ['Skipper', 'Crew 2']) {
            expect(dateField(who).type).toBe('date');
            expect(screen.queryByLabelText(`${who} age`)).toBeNull();
        }
        // Not after today, by this phone's own calendar.
        expect(dateField('Skipper').max).toBe('2026-10-14');
        expect(dateField('Skipper').min).toBe('1900-01-01');
    });

    it('stores the date as yyyy-mm-dd, and shows the age it gives today beside it', () => {
        const onSave = vi.fn();
        const { rerender } = render(
            <VesselTab settings={settingsWith([{ name: 'Ingrid Solberg', rank: 'Skipper' }])} onSave={onSave} />,
        );
        fireEvent.change(dateField('Skipper'), { target: { value: '1979-03-04' } });
        const roster = savedRoster(onSave)!;
        expect(roster[0]).toEqual({ name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-03-04', age: 47 });
        rerender(<VesselTab settings={settingsWith(roster)} onSave={onSave} />);
        expect(dateField('Skipper').value).toBe('1979-03-04');
        expect(dateField('Skipper')).toHaveAccessibleDescription('Age 47 today');
        expect(screen.getByText('Age 47 today')).toBeInTheDocument();
    });

    it('keeps an age typed before, with a gentle note, until a date of birth is entered', () => {
        const onSave = vi.fn();
        const { rerender } = render(
            <VesselTab
                settings={settingsWith([
                    { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-03-04' },
                    { name: 'Kenji Watanabe', rank: 'First mate', age: 52 },
                ])}
                onSave={onSave}
            />,
        );
        expect(dateField('Crew 2').value).toBe('');
        expect(screen.getByText('Age 52 from before. Add date of birth so this stays right.')).toBeInTheDocument();
        fireEvent.change(dateField('Crew 2'), { target: { value: '1974-01-20' } });
        const roster = savedRoster(onSave)!;
        expect(roster[1]).toEqual({ name: 'Kenji Watanabe', rank: 'First mate', dateOfBirth: '1974-01-20', age: 52 });
        rerender(<VesselTab settings={settingsWith(roster)} onSave={onSave} />);
        expect(screen.queryByText(/from before/)).toBeNull();
        expect(screen.getByText('Age 52 today')).toBeInTheDocument();
    });

    it('clearing the date takes the age it gave with it', () => {
        const onSave = vi.fn();
        render(
            <VesselTab
                settings={settingsWith([
                    { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-03-04', age: 47 },
                ])}
                onSave={onSave}
            />,
        );
        fireEvent.change(dateField('Skipper'), { target: { value: '' } });
        expect(savedRoster(onSave)![0]).toEqual({ name: 'Ingrid Solberg', rank: 'Skipper' });
    });

    // Typed on a keyboard in the web build (129-14 review): Chromium reports
    // the year digit by digit, and an empty value while a part is retyped.
    const partTyped = (field: HTMLInputElement, badInput: boolean) =>
        Object.defineProperty(field, 'validity', { configurable: true, get: () => ({ badInput }) });

    it('keeps a year that is still being typed in the field, and saves only the whole date', () => {
        const onSave = vi.fn();
        render(<VesselTab settings={settingsWith([{ name: 'Amara Okafor', rank: 'Crew' }])} onSave={onSave} />);
        const field = dateField('Skipper');
        for (const value of ['0001-04-03', '0019-04-03', '0197-04-03']) {
            fireEvent.change(field, { target: { value } });
            // Put back to '' here, Chromium's field emptied itself on the first digit.
            expect(field.value, value).toBe(value);
        }
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: '1979-04-03' } });
        expect(field.value).toBe('1979-04-03');
        expect(savedRoster(onSave)![0]).toEqual({
            name: 'Amara Okafor',
            rank: 'Crew',
            dateOfBirth: '1979-04-03',
            age: 47,
        });
    });

    it('a part being retyped is not a cleared date; left part typed, the field shows the saved date', () => {
        const onSave = vi.fn();
        render(
            <VesselTab
                settings={settingsWith([
                    { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-03-04', age: 47 },
                ])}
                onSave={onSave}
            />,
        );
        const field = dateField('Skipper');
        partTyped(field, true);
        fireEvent.change(field, { target: { value: '' } });
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.blur(field);
        expect(onSave).not.toHaveBeenCalled();
        expect(field.value).toBe('1979-03-04');
        // A year before 1900, left as it is: the saved date again, nothing saved.
        partTyped(field, false);
        fireEvent.change(field, { target: { value: '0197-03-04' } });
        fireEvent.blur(field);
        expect(field.value).toBe('1979-03-04');
        expect(onSave).not.toHaveBeenCalled();
    });

    it('every part emptied, and nothing said until the field is left: cleared then', () => {
        const onSave = vi.fn();
        render(
            <VesselTab
                settings={settingsWith([
                    { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-03-04', age: 47 },
                ])}
                onSave={onSave}
            />,
        );
        const field = dateField('Skipper');
        // The first part emptied: Chromium says '' with part of a date still held.
        partTyped(field, true);
        fireEvent.change(field, { target: { value: '' } });
        // The last part emptied fires nothing; the field is left with none held.
        partTyped(field, false);
        fireEvent.blur(field);
        expect(savedRoster(onSave)![0]).toEqual({ name: 'Ingrid Solberg', rank: 'Skipper' });
    });

    it('a date saved from elsewhere replaces what the field shows', () => {
        const onSave = vi.fn();
        const { rerender } = render(
            <VesselTab settings={settingsWith([{ name: 'Ingrid Solberg', rank: 'Skipper' }])} onSave={onSave} />,
        );
        expect(dateField('Skipper').value).toBe('');
        rerender(
            <VesselTab
                settings={settingsWith([{ name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1988-12-31' }])}
                onSave={onSave}
            />,
        );
        expect(dateField('Skipper').value).toBe('1988-12-31');
    });

    for (const [where, tz, offset, age] of [
        // 11:30 UTC on 14 October: 00:30 on the 15th in Tonga, her birthday.
        ['UTC+13', 'Pacific/Tongatapu', -13 * 60, 'Age 47 today'],
        // The same instant is 01:30 on the 14th in Honolulu: the day before.
        ['UTC-10', 'Pacific/Honolulu', 10 * 60, 'Age 46 today'],
    ] as const) {
        it(`entered at ${where}, the date is the one picked, and the age is by that phone's own day`, () => {
            process.env.TZ = tz;
            vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, 11, 30)));
            expect(new Date().getTimezoneOffset(), 'the zone took').toBe(offset);
            const onSave = vi.fn();
            const { rerender } = render(
                <VesselTab settings={settingsWith([{ name: 'Ingrid Solberg', rank: 'Skipper' }])} onSave={onSave} />,
            );
            fireEvent.change(dateField('Skipper'), { target: { value: '1979-10-15' } });
            const roster = savedRoster(onSave)!;
            expect(roster[0].dateOfBirth).toBe('1979-10-15');
            rerender(<VesselTab settings={settingsWith(roster)} onSave={onSave} />);
            expect(dateField('Skipper').value).toBe('1979-10-15');
            expect(screen.getByText(age)).toBeInTheDocument();
        });
    }
});
