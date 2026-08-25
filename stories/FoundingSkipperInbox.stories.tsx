import type { Meta, StoryObj } from '@storybook/react-vite';
import type { FoundingSkipperInboxService } from '../components/admin/FoundingSkipperInbox';
import { FoundingSkipperInbox } from '../components/admin/FoundingSkipperInbox';
import type { FoundingSkipperApplicationRecord, FoundingSkipperStatus } from '../types/foundingSkippers';

const applications: FoundingSkipperApplicationRecord[] = [
    {
        id: '0198da8b-1ed2-4000-8000-000000000001',
        name: 'Casey Morgan',
        email: 'casey@example.com',
        boat_type: 'sail_monohull',
        home_waters: 'Moreton Bay',
        apple_device: 'iphone_and_ipad',
        boating_frequency: 'weekly_plus',
        interests: ['marine_weather', 'passage_planning', 'float_plans', 'anchor_watch'],
        notes: 'Regular coastal passages north from Manly. Happy to test in ugly weather and send blunt feedback.',
        source: 'personal-email',
        consent_version: 'founding-skippers-v1',
        consented_at: '2026-08-25T10:37:11.807Z',
        status: 'new',
        status_updated_at: null,
        status_updated_by: null,
        created_at: '2026-08-25T10:37:11.807Z',
        expires_at: '2027-02-21T10:37:11.807Z',
    },
    {
        id: '0198da8b-1ed2-4000-8000-000000000002',
        name: 'Alex Chen',
        email: 'alex@example.com',
        boat_type: 'sail_multihull',
        home_waters: 'Whitsundays',
        apple_device: 'ipad',
        boating_frequency: 'fortnightly',
        interests: ['marine_weather', 'anchor_watch', 'voyage_logging', 'onboard_data'],
        notes: null,
        source: 'club-flyer',
        consent_version: 'founding-skippers-v1',
        consented_at: '2026-08-24T01:15:00.000Z',
        status: 'contacted',
        status_updated_at: '2026-08-24T05:30:00.000Z',
        status_updated_by: 'a4dbb302-d4ab-43a5-881f-737e9c56d50c',
        created_at: '2026-08-24T01:15:00.000Z',
        expires_at: '2027-02-20T01:15:00.000Z',
    },
    {
        id: '0198da8b-1ed2-4000-8000-000000000003',
        name: 'Jordan Reid',
        email: 'jordan@example.com',
        boat_type: 'power',
        home_waters: 'Gold Coast Broadwater',
        apple_device: 'iphone',
        boating_frequency: 'monthly',
        interests: ['marine_weather', 'float_plans'],
        notes: 'Trailerable cruiser and frequent bar crossings.',
        source: 'qr-flyer',
        consent_version: 'founding-skippers-v1',
        consented_at: '2026-08-22T23:00:00.000Z',
        status: 'accepted',
        status_updated_at: '2026-08-23T00:10:00.000Z',
        status_updated_by: 'a4dbb302-d4ab-43a5-881f-737e9c56d50c',
        created_at: '2026-08-22T23:00:00.000Z',
        expires_at: '2027-02-18T23:00:00.000Z',
    },
];

function createPreviewService(): FoundingSkipperInboxService {
    return {
        canReview: () => Promise.resolve(true),
        list: ({ status }: { status?: FoundingSkipperStatus | null } = {}) =>
            Promise.resolve({
                applications: status
                    ? applications.filter((application) => application.status === status)
                    : applications,
                nextCursor: null,
            }),
        review: () => Promise.resolve(),
    };
}

const service = createPreviewService();

const meta: Meta<typeof FoundingSkipperInbox> = {
    title: 'Admin/FoundingSkipperInbox',
    component: FoundingSkipperInbox,
    parameters: {
        layout: 'fullscreen',
        backgrounds: { default: 'thalassa-dark' },
    },
    decorators: [
        (Story) => (
            <main className="min-h-screen bg-slate-950 text-white">
                <div className="mx-auto min-h-screen max-w-6xl">
                    <Story />
                </div>
            </main>
        ),
    ],
};

export default meta;
type Story = StoryObj<typeof FoundingSkipperInbox>;

export const LoadedInbox: Story = { args: { service } };

export const EmptyInbox: Story = {
    args: {
        service: {
            ...service,
            list: () => Promise.resolve({ applications: [], nextCursor: null }),
        },
    },
};

export const Unavailable: Story = {
    args: {
        service: {
            ...service,
            list: () => Promise.reject(new Error('Applications could not be loaded.')),
        },
    },
};
