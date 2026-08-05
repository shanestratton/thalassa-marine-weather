import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FloatPlanSheet, type FloatPlanPreset } from '../components/vessel/FloatPlanSheet';
import { defaultVesselProfile } from '../services/VesselFleetService';
import { useSettingsStore } from '../stores/settingsStore';

const vessel = {
    ...defaultVesselProfile('Serene Summer'),
    model: 'Tayana 55',
    hullType: 'monohull' as const,
    length: 55,
    hullColor: 'white',
    registration: 'MQ258Q',
    mmsi: '501240101',
    callSign: 'VK4AFY',
    epirbHexId: '1D0E7A2B3C4D5E6',
    liferaftCapacity: 6,
    liferaftServiceDate: '2026-03-14',
    flaresExpiry: '2027-06-30',
    safetyNotes: 'PLB ×2 · grab bag · drogue',
    contactPhone: '+61 400 000 000',
    crewCount: 3,
};

const departureMs = new Date('2026-08-10T00:00:00.000Z').getTime();
const preset: FloatPlanPreset = {
    route: {
        name: 'Capricorn passage',
        from: 'Newport',
        to: 'Lady Musgrave',
        distanceNM: 178,
        waypoints: [
            { lat: -27.14, lon: 153.09 },
            { lat: -26.2, lon: 152.95 },
            { lat: -24.8, lon: 152.7 },
            { lat: -23.9, lon: 152.4 },
        ],
    },
    departureMs,
    etaMs: departureMs + 30 * 3_600_000,
    personsOnBoard: 3,
};

function FloatPlanStory() {
    useEffect(() => {
        const previous = useSettingsStore.getState().settings.vessel;
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, vessel } }));
        return () => useSettingsStore.setState((state) => ({ settings: { ...state.settings, vessel: previous } }));
    }, []);

    return (
        <main className="min-h-screen bg-slate-950 px-3 py-5 text-white sm:px-6">
            <div className="mx-auto max-w-3xl">
                <FloatPlanSheet preset={preset} onClose={() => undefined} />
            </div>
        </main>
    );
}

const meta: Meta<typeof FloatPlanStory> = {
    title: 'Vessel/FloatPlanSheet',
    component: FloatPlanStory,
    parameters: {
        layout: 'fullscreen',
        backgrounds: { default: 'thalassa-dark' },
    },
};

export default meta;
type Story = StoryObj<typeof FloatPlanStory>;

export const FullSafetyPlan: Story = {};
