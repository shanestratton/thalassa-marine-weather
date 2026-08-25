import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundingSkipperInboxService } from '../components/admin/FoundingSkipperInbox';
import type { FoundingSkipperApplicationRecord } from '../types/foundingSkippers';
import { setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../components/ui/ConfirmDialog', () => ({
    ConfirmDialog: ({
        isOpen,
        title,
        message,
        confirmLabel,
        onConfirm,
    }: {
        isOpen: boolean;
        title: string;
        message: string;
        confirmLabel: string;
        onConfirm: () => Promise<void>;
    }) =>
        isOpen ? (
            <div role="dialog" aria-label={title}>
                <p>{message}</p>
                <button onClick={() => void onConfirm()}>{confirmLabel}</button>
            </div>
        ) : null,
}));

vi.mock('../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { FoundingSkipperInbox } from '../components/admin/FoundingSkipperInbox';

const application: FoundingSkipperApplicationRecord = {
    id: '1b29ebd3-95be-4738-90be-c82b6acde44d',
    name: 'Shane Stratton',
    email: 'shane.stratton@gmail.com',
    boat_type: 'sail_monohull',
    home_waters: 'Moreton Bay',
    apple_device: 'iphone_and_ipad',
    boating_frequency: 'weekly_plus',
    interests: ['marine_weather', 'anchor_watch'],
    notes: 'Straight-up feedback only.',
    source: 'personal-email',
    consent_version: 'founding-skippers-v1',
    consented_at: '2026-08-25T10:37:11.807Z',
    status: 'new',
    status_updated_at: null,
    status_updated_by: null,
    created_at: '2026-08-25T10:37:11.807Z',
    expires_at: '2027-02-21T10:37:11.807Z',
};

function service(overrides: Partial<FoundingSkipperInboxService> = {}): FoundingSkipperInboxService {
    return {
        canReview: vi.fn().mockResolvedValue(true),
        list: vi.fn().mockResolvedValue({ applications: [application], nextCursor: null }),
        review: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('FoundingSkipperInbox', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('loads the private application details without caching or obscuring the source', async () => {
        const inbox = service();
        render(<FoundingSkipperInbox service={inbox} />);

        expect((await screen.findAllByText('Shane Stratton')).length).toBeGreaterThan(0);
        expect(screen.getByText('Moreton Bay')).toBeInTheDocument();
        expect(screen.getAllByText('Personal Email').length).toBeGreaterThan(0);
        expect(screen.getByText('Straight-up feedback only.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Draft email to Shane/i })).toHaveAttribute(
            'href',
            expect.stringContaining('mailto:shane.stratton%40gmail.com'),
        );
        expect(inbox.list).toHaveBeenCalledWith({ status: null, cursor: null, limit: 50 });
    });

    it('makes accepted an explicit status-only action and tells the reviewer what it does not send', async () => {
        const inbox = service();
        render(<FoundingSkipperInbox service={inbox} />);
        await screen.findAllByText('Shane Stratton');

        fireEvent.click(screen.getByRole('button', { name: 'Mark Accepted' }));
        const dialog = screen.getByRole('dialog', { name: 'Mark Accepted' });
        expect(dialog).toHaveTextContent('does not send an email or a TestFlight invitation');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Mark Accepted' }));

        await waitFor(() => expect(inbox.review).toHaveBeenCalledWith(application.id, 'new', 'accepted'));
        expect((await screen.findAllByText('Accepted')).length).toBeGreaterThan(0);
    });

    it('removes an application from a filtered queue after its status changes', async () => {
        const inbox = service();
        render(<FoundingSkipperInbox service={inbox} />);
        await screen.findAllByText('Shane Stratton');

        fireEvent.click(screen.getByRole('button', { name: 'New' }));
        await waitFor(() => expect(inbox.list).toHaveBeenLastCalledWith({ status: 'new', cursor: null, limit: 50 }));

        fireEvent.click(screen.getByRole('button', { name: 'Mark Accepted' }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Mark Accepted' })).getByRole('button'));

        await waitFor(() => expect(screen.queryAllByText('Shane Stratton')).toHaveLength(0));
        expect(screen.getByText('There are no new applications.')).toBeInTheDocument();
    });

    it('locks withdrawn applications and removes contact actions', async () => {
        render(<FoundingSkipperInbox service={service()} />);
        await screen.findAllByText('Shane Stratton');

        fireEvent.click(screen.getByRole('button', { name: 'Mark Withdrawn' }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Mark Withdrawn' })).getByRole('button'));

        expect(await screen.findByText(/Withdrawn applications are locked/i)).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Draft email/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: application.email })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Mark /i })).not.toBeInTheDocument();
    });

    it('shows a real load failure rather than pretending the queue is empty', async () => {
        const inbox = service({ list: vi.fn().mockRejectedValue(new Error('Secure inbox unavailable.')) });
        render(<FoundingSkipperInbox service={inbox} />);

        expect(await screen.findByText('Applications unavailable')).toBeInTheDocument();
        expect(screen.getByText('Secure inbox unavailable.')).toBeInTheDocument();
        expect(screen.queryByText('No applications here')).not.toBeInTheDocument();
    });

    it('clears applicant PII immediately when the signed-in identity changes', async () => {
        render(<FoundingSkipperInbox service={service()} />);
        expect((await screen.findAllByText('Shane Stratton')).length).toBeGreaterThan(0);

        fireEvent.change(screen.getByLabelText('Search Founding Skipper applications'), {
            target: { value: 'shane.stratton@gmail.com' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Mark Accepted' }));
        expect(screen.getByRole('dialog', { name: 'Mark Accepted' })).toHaveTextContent('Shane Stratton');

        setAuthIdentityScope('account-b');

        await waitFor(() => expect(screen.queryAllByText('Shane Stratton')).toHaveLength(0));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Search Founding Skipper applications')).toHaveValue('');
        expect(screen.getByText(/signed-in account changed/i)).toBeInTheDocument();
    });
});
