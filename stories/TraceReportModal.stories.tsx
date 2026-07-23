import type { Meta, StoryObj } from '@storybook/react-vite';
import { TraceReportModal } from '../components/map/TraceReportModal';
import type { TraceLegVerdict } from '../services/routeTracer';

const pins = [
    { lat: -27.471, lon: 153.024 },
    { lat: -27.57, lon: 153.1 },
    { lat: -27.66, lon: 153.22 },
];

const caution: TraceLegVerdict = {
    grade: 'caution',
    issues: [{ severity: 'caution', message: 'Depth is tight near the leading mark' }],
    minDepthM: 2.1,
    minAt: pins[1],
    needsTide: true,
    nudge: 'Favour the marked channel',
    nudgeTo: null,
};

const danger: TraceLegVerdict = {
    grade: 'danger',
    issues: [{ severity: 'danger', message: 'Unverified shallow water on this leg' }],
    minDepthM: 1.1,
    minAt: pins[2],
    needsTide: true,
    nudge: null,
    nudgeTo: null,
};

const meta: Meta<typeof TraceReportModal> = {
    title: 'Map/TraceReportModal',
    component: TraceReportModal,
    parameters: {
        layout: 'fullscreen',
        backgrounds: { default: 'thalassa-dark' },
    },
};

export default meta;
type Story = StoryObj<typeof TraceReportModal>;

const callbacks = {
    onClose: () => undefined,
    onFlyTo: () => undefined,
    onFixLeg: () => undefined,
    onFixAll: () => undefined,
    onAckLeg: () => undefined,
};

export const SafetyReview: Story = {
    args: {
        ...callbacks,
        open: true,
        pins,
        routeName: 'Brisbane to Moreton Bay',
        verdicts: [caution, danger],
        tideLabels: { 0: 'Wait for the rising tide at the bar' },
        departureLabel: 'Leave from 09:10 to 13:30 and every tide gate clears',
        ackedLegs: new Set<number>(),
        fixBusy: null,
        vesselName: 'Thalassa',
        draftM: 1.7,
        cruisingSpeedKts: 6,
        departureMs: Date.UTC(2026, 6, 23, 9, 10),
    },
};

export const ClearRoute: Story = {
    args: {
        ...callbacks,
        open: true,
        pins,
        routeName: 'Clearwater passage',
        verdicts: [
            {
                ...caution,
                grade: 'clear',
                issues: [{ severity: 'info', message: 'Marked channel checks clear' }],
                needsTide: false,
            },
        ],
        tideLabels: {},
        departureLabel: '',
        ackedLegs: new Set<number>(),
        fixBusy: null,
    },
};
