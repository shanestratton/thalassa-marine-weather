import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const usage = vi.hoisted(() => vi.fn());
vi.mock('../services/DiaryService', () => ({ DiaryService: { getMediaUsage: usage } }));
import { CloudStorageSection } from '../components/settings/VoyageLogTab';
import { setAuthIdentityScope } from '../services/authIdentityScope';

beforeEach(() => {
    setAuthIdentityScope('usage-a');
    usage.mockReset();
});

describe('actual cloud storage usage', () => {
    it('re-reads the catalog after a confirmed deletion and on manual refresh', async () => {
        usage.mockResolvedValueOnce([{ bucket: 'diary-video', bytes: 1024, objects: 4 }]);
        render(<CloudStorageSection />);
        expect(await screen.findByText('1 KB · 4')).toBeInTheDocument();
        usage.mockResolvedValueOnce([{ bucket: 'diary-video', bytes: 512, objects: 2 }]);
        act(() => window.dispatchEvent(new Event('thalassa:diary-deleted')));
        expect(await screen.findByText('512 B · 2')).toBeInTheDocument();
        usage.mockResolvedValueOnce([]);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh cloud storage usage' }));
        await waitFor(() => expect(usage).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(screen.queryByText('512 B · 2')).not.toBeInTheDocument());
    });

    it('does not replace another account’s count with a late response', async () => {
        let finish!: (value: unknown) => void;
        usage.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        render(<CloudStorageSection />);
        await waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
        usage.mockResolvedValueOnce([{ bucket: 'diary-video', bytes: 42, objects: 1 }]);
        act(() => setAuthIdentityScope('usage-b'));
        expect(await screen.findByText('42 B · 1')).toBeInTheDocument();
        await act(async () => finish([{ bucket: 'diary-video', bytes: 999, objects: 99 }]));
        expect(screen.queryByText('999 B · 99')).not.toBeInTheDocument();
        expect(screen.getByText('42 B · 1')).toBeInTheDocument();
    });

    it('shows unavailable, not a made-up zero, if the cloud cannot be reached', async () => {
        usage.mockResolvedValueOnce(null);
        render(<CloudStorageSection />);
        expect(await screen.findByText("Couldn't reach the cloud — try again later.")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh cloud storage usage' })).toBeEnabled();
    });
});
