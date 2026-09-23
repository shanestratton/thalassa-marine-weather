import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryCommentModeration } from '../components/diary/DiaryCommentModeration';
const api = vi.hoisted(() => ({ list: vi.fn(), moderate: vi.fn() }));
const identity = vi.hoisted(() => ({ onChange: undefined as (() => void) | undefined }));
vi.mock('../services/DiaryCommentService', () => ({
    listDiaryGuestComments: api.list,
    moderateDiaryGuestComment: api.moderate,
}));
vi.mock('../services/authIdentityScope', () => ({
    subscribeAuthIdentityScope: (callback: () => void) => {
        identity.onChange = callback;
        return () => {
            identity.onChange = undefined;
        };
    },
}));
beforeEach(() => {
    api.list.mockReset().mockResolvedValue([
        {
            id: 'one',
            guest_name: 'Marta',
            body: 'Lovely!',
            status: 'pending',
            created_at: new Date().toISOString(),
        },
    ]);
    api.moderate.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
describe('skipper comment approval', () => {
    it('shows the selected entry review queue immediately and does not approve optimistically', async () => {
        let finish!: () => void;
        api.moderate.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        render(<DiaryCommentModeration entryId="entry" />);
        expect(api.list).toHaveBeenCalledExactlyOnceWith('entry');
        expect(screen.getByRole('button', { name: 'Guest comments' })).toHaveAttribute('aria-expanded', 'true');
        await screen.findByText('Lovely!');
        expect(screen.getByRole('button', { name: 'Guest comments · 1 to review' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        expect(screen.getByText('Awaiting approval')).toBeTruthy();
        expect(api.moderate).toHaveBeenCalledWith('one', 'approve');
        finish();
        await screen.findByText('Approved');
    });
    it('preserves pending state when server revokes approval authority', async () => {
        api.moderate.mockRejectedValue(new Error('Only the public-log owner can review it.'));
        render(<DiaryCommentModeration entryId="entry" />);
        await screen.findByText('Lovely!');
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        await screen.findByRole('alert');
        expect(screen.getByText('Awaiting approval')).toBeTruthy();
    });
    it('removes rejected comments from the queue after server confirmation', async () => {
        render(<DiaryCommentModeration entryId="entry" />);
        await screen.findByText('Lovely!');
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
        await waitFor(() => expect(screen.queryByText('Lovely!')).toBeNull());
    });
    it('does not offer cloud moderation on a still-offline diary entry', () => {
        const view = render(<DiaryCommentModeration entryId="offline-one" />);
        expect(view.container.textContent).toBe('');
        expect(api.list).not.toHaveBeenCalled();
    });
    it('can collapse the section and refresh it on reopening', async () => {
        render(<DiaryCommentModeration entryId="entry" />);
        await screen.findByText('Lovely!');
        fireEvent.click(screen.getByRole('button', { name: /Guest comments/ }));
        expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
        expect(api.list).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Guest comments' }));
        await screen.findByText('Lovely!');
        expect(api.list).toHaveBeenCalledTimes(2);
    });
    it('offers an explicit retry if the entry comments cannot be loaded', async () => {
        api.list.mockRejectedValueOnce(new Error('Comments could not be loaded. Try again when connected.'));
        render(<DiaryCommentModeration entryId="entry" />);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh comments' }));
        await screen.findByText('Lovely!');
        expect(screen.queryByRole('alert')).toBeNull();
    });
    it('disables moderation while refreshing so a stale read cannot undo an approval', async () => {
        render(<DiaryCommentModeration entryId="entry" />);
        await screen.findByText('Lovely!');
        let finish!: (rows: []) => void;
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Refresh comments' }));
        expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
        await act(async () => {
            finish([]);
        });
        expect(screen.getByText('No comments to review yet.')).toBeTruthy();
    });
    it('discards a late read after the signed-in account changes', async () => {
        let finish!: (rows: unknown[]) => void;
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        render(<DiaryCommentModeration entryId="entry" />);
        act(() => identity.onChange?.());
        await act(async () => {
            finish([{ id: 'old', guest_name: 'Old owner', body: 'Private pending comment', status: 'pending' }]);
        });
        expect(screen.queryByText('Private pending comment')).toBeNull();
        expect(screen.getByRole('button', { name: 'Guest comments' })).toHaveAttribute('aria-expanded', 'false');
    });
});
