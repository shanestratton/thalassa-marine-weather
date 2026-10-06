/**
 * DiaryVideo — the clip player in the diary's video sheet and entry view.
 *
 * While a clip resolves it holds a player-sized space that says so in words
 * (it was an empty, unlabelled box), and a clip that cannot be resolved says
 * that, rather than leaving the box empty for good (2026-10-06). A clip that
 * resolves but will not load (a cached signed URL out of coverage, a container
 * the webview cannot decode) says so too, instead of a black player.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveVideoUrl = vi.fn<(ref: string) => Promise<string | null>>();
vi.mock('../services/DiaryService', () => ({
    DiaryService: { resolveVideoUrl: (ref: string) => resolveVideoUrl(ref) },
}));

import { DiaryVideo } from '../components/diary/DiaryVideo';

afterEach(() => resolveVideoUrl.mockReset());

describe('DiaryVideo', () => {
    it('plays a local clip at once', () => {
        const { container } = render(<DiaryVideo src="blob:diary-local-clip" className="w-full" />);
        expect(container.querySelector('video')).toHaveAttribute('src', 'blob:diary-local-clip');
        expect(resolveVideoUrl).not.toHaveBeenCalled();
    });

    it('says it is loading, in a player-sized space, until the clip resolves', async () => {
        let finish!: (url: string | null) => void;
        resolveVideoUrl.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const { container } = render(<DiaryVideo src="storage:diary-video:skipper/clip.mp4" className="w-full" />);
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Video loading…');
        expect(status).toHaveClass('aspect-video', 'w-full');
        expect(container.querySelector('video')).toBeNull();

        await act(async () => finish('https://storage.example.test/signed/clip.mp4'));
        expect(container.querySelector('video')).toHaveAttribute('src', 'https://storage.example.test/signed/clip.mp4');
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('says so when the clip cannot be resolved, or the lookup fails', async () => {
        resolveVideoUrl.mockResolvedValueOnce(null);
        const { container, rerender } = render(<DiaryVideo src="idb-video:gone" />);
        expect(await screen.findByText("This video can't be loaded right now.")).toBeInTheDocument();
        expect(container.querySelector('video')).toBeNull();

        resolveVideoUrl.mockRejectedValueOnce(new Error('offline'));
        rerender(<DiaryVideo src="storage:diary-video:skipper/other.mp4" />);
        // A new clip starts over: loading, then the honest failure.
        expect(screen.getByRole('status')).toHaveTextContent('Video loading…');
        expect(await screen.findByText("This video can't be loaded right now.")).toBeInTheDocument();
    });

    it('says so when a resolved clip will not load, instead of a dead black player', async () => {
        resolveVideoUrl.mockResolvedValueOnce('https://storage.example.test/signed/stale.mp4');
        const { container } = render(<DiaryVideo src="storage:diary-video:skipper/stale.mp4" />);
        await act(async () => {});
        const video = container.querySelector('video');
        expect(video).toHaveAttribute('src', 'https://storage.example.test/signed/stale.mp4');

        fireEvent.error(video!);
        expect(container.querySelector('video')).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent("This video can't be loaded right now.");
    });

    it('a local clip that cannot be decoded says so as well', () => {
        const { container } = render(<DiaryVideo src="blob:diary-undecodable" />);
        fireEvent.error(container.querySelector('video')!);
        expect(screen.getByRole('status')).toHaveTextContent("This video can't be loaded right now.");
    });

    it('its words keep a px floor, not the fluid text-sm (11.4 px at 320)', () => {
        resolveVideoUrl.mockReturnValue(new Promise(() => {}));
        render(<DiaryVideo src="storage:diary-video:skipper/slow.mp4" />);
        const status = screen.getByRole('status');
        expect(status).toHaveClass('text-[13px]');
        expect(status).not.toHaveClass('text-sm');
    });
});
