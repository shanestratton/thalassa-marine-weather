import type { Meta, StoryObj } from '@storybook/react-vite';

import { CrewPhoneVerificationPanel } from '../components/crew-finder/CrewPhoneVerificationPanel';
import type { CrewPhoneVerificationController } from '../hooks/useCrewPhoneVerification';

const noop = () => undefined;
const asyncNoop = async () => undefined;

function controller(overrides: Partial<CrewPhoneVerificationController> = {}): CrewPhoneVerificationController {
    return {
        signedIn: true,
        loading: false,
        status: { verified: false, last4: null, verifiedAt: null, emailVerified: true },
        pending: null,
        publicationState: 'blocked',
        publicationReady: false,
        countryCode: 'AU',
        localNumber: '',
        code: '',
        error: '',
        starting: false,
        checking: false,
        removing: false,
        cooldownSeconds: 0,
        setCountryCode: noop,
        setLocalNumber: noop,
        setCode: noop,
        start: asyncNoop,
        check: asyncNoop,
        resend: asyncNoop,
        changeNumber: noop,
        remove: asyncNoop,
        refresh: asyncNoop,
        ...overrides,
    };
}

const meta: Meta<typeof CrewPhoneVerificationPanel> = {
    title: 'Crew List/Phone Verification',
    component: CrewPhoneVerificationPanel,
    decorators: [
        (Story) => (
            <div style={{ minHeight: '100vh', background: '#020617', padding: 16 }}>
                <div style={{ width: '100%', maxWidth: 430, margin: '0 auto' }}>
                    <Story />
                </div>
            </div>
        ),
    ],
    parameters: {
        layout: 'fullscreen',
        backgrounds: { default: 'thalassa-dark' },
        viewport: { defaultViewport: 'mobile2' },
    },
};

export default meta;
type Story = StoryObj<typeof CrewPhoneVerificationPanel>;

export const EnterNumber: Story = {
    args: { controller: controller() },
};

export const CodeSent: Story = {
    args: {
        controller: controller({
            pending: {
                status: 'pending',
                last4: '6789',
                retryAfterSeconds: 60,
                expiresAt: '2026-08-28T10:10:00.000Z',
            },
            cooldownSeconds: 42,
        }),
    },
};

export const Verified: Story = {
    args: {
        controller: controller({
            status: {
                verified: true,
                last4: '6789',
                verifiedAt: '2026-08-28T10:00:00.000Z',
                emailVerified: true,
            },
            publicationState: 'ready',
            publicationReady: true,
        }),
    },
};

export const EmailStillNeeded: Story = {
    args: {
        controller: controller({
            status: {
                verified: true,
                last4: '6789',
                verifiedAt: '2026-08-28T10:00:00.000Z',
                emailVerified: false,
            },
        }),
    },
};
