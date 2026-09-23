import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicDiaryComments } from '../src/components/PublicDiaryComments';
const api = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn() }));
vi.mock('../src/diaryCommentsApi', () => ({ readPublicDiaryComments: api.read, submitPublicDiaryComment: api.submit }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const props = { handle: 'serene-summer', entryId: '00000000-0000-4000-8000-000000000001' };
beforeEach(() => {
    api.read.mockReset().mockResolvedValue([]);
    api.submit.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
const fill = () => {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Shane' } });
    fireEvent.change(screen.getByLabelText('Your comment'), { target: { value: 'Great trip!' } });
};
describe('public guest comments', () => {
    it('sends without login and confirms pending without adding the comment publicly', async () => {
        render(<PublicDiaryComments {...props} />);
        await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
        expect(await screen.findByText(/waiting for the skipper/)).toBeTruthy();
        expect(api.submit.mock.calls[0][0]).toMatchObject({
            handle: props.handle,
            entry_id: props.entryId,
            guest_name: 'Shane',
            body: 'Great trip!',
            website: '',
        });
        expect(screen.queryByText('Great trip!')).toBeNull();
    });
    it('retains the same submission id after an uncertain network failure', async () => {
        api.submit.mockRejectedValueOnce(new Error('Network failed'));
        render(<PublicDiaryComments {...props} />);
        await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Reload comments' }));
        await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
        expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Shane');
        expect((screen.getByLabelText('Your comment') as HTMLTextAreaElement).value).toBe('Great trip!');
        fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
        await screen.findByText(/waiting for the skipper/);
        expect(api.submit.mock.calls[1][0].submission_id).toBe(api.submit.mock.calls[0][0].submission_id);
    });
    it('escapes hostile approved text and rejects links before sending', async () => {
        api.read.mockResolvedValue([
            {
                id: 'one',
                guest_name: '<img src=x>',
                body: '<script>alert(1)</script>',
                created_at: new Date().toISOString(),
            },
        ]);
        const view = render(<PublicDiaryComments {...props} />);
        await screen.findByText('<img src=x>');
        expect(view.container.querySelector('img, script')).toBeNull();
        fill();
        fireEvent.change(screen.getByLabelText('Your comment'), { target: { value: 'https://example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
        expect(api.submit).not.toHaveBeenCalled();
    });
    it('aborts stale entry work and does not show another entry’s pending result', async () => {
        const pending = deferred<void>();
        api.submit.mockReturnValue(pending.promise);
        const view = render(<PublicDiaryComments {...props} />);
        await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
        const signal = api.submit.mock.calls[0][1] as AbortSignal;
        view.rerender(<PublicDiaryComments {...props} entryId="00000000-0000-4000-8000-000000000002" />);
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve());
        expect(screen.queryByText(/waiting for the skipper/)).toBeNull();
        expect((screen.getByLabelText('Your comment') as HTMLTextAreaElement).value).toBe('');
    });
});
