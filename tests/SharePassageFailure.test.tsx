import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PassageBriefData } from '../services/PassageBriefService';

const shareMocks = vi.hoisted(() => ({
    share: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    clipboardWrite: vi.fn(),
}));

vi.mock('@capacitor/share', () => ({
    Share: { share: shareMocks.share },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: { writeFile: shareMocks.writeFile, deleteFile: shareMocks.deleteFile },
    Directory: { Cache: 'CACHE' },
    Encoding: {},
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import SharePassageButton from '../components/passage/SharePassageButton';

const completeBrief: PassageBriefData = {
    routeName: 'Moreton Bay Passage',
    origin: { name: 'Manly', lat: -27.45, lon: 153.19 },
    destination: { name: 'Tangalooma', lat: -27.18, lon: 153.37 },
    departureTime: '2026-08-05T00:00:00.000Z',
    totalDistanceNM: 22,
    estimatedDuration: 4,
    speed: 6,
    crewCount: 3,
};

describe('passage share failure recovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shareMocks.share.mockResolvedValue(undefined);
        shareMocks.writeFile.mockResolvedValue({ uri: 'file:///passage.pdf' });
        shareMocks.deleteFile.mockResolvedValue(undefined);
        shareMocks.clipboardWrite.mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: shareMocks.clipboardWrite },
        });
    });

    it('shows an assertive selectable fallback and retries a failed text share', async () => {
        shareMocks.share.mockRejectedValueOnce(new Error('share sheet unavailable')).mockResolvedValue(undefined);
        render(<SharePassageButton briefData={completeBrief} />);

        fireEvent.click(screen.getByRole('button', { name: 'Open share passage menu' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /Quick Passage Brief/ }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Nothing has been marked as sent');
        // Label reworded 2026-09-03: the old one named the mechanism, not the task.
        const fallback = screen.getByLabelText('Passage brief text — copy and send it yourself');
        expect((fallback as HTMLTextAreaElement).value).toContain('Manly');

        fireEvent.click(screen.getByRole('button', { name: 'Retry share' }));
        await waitFor(() => expect(shareMocks.share).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });

    it('keeps manual text selectable when clipboard access also fails', async () => {
        shareMocks.share.mockRejectedValueOnce(new Error('share failed'));
        shareMocks.clipboardWrite.mockRejectedValueOnce(new Error('clipboard blocked'));
        render(<SharePassageButton briefData={completeBrief} />);

        fireEvent.click(screen.getByRole('button', { name: 'Open share passage menu' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /Quick Passage Brief/ }));
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Copy fallback text' }));

        expect(await screen.findByText(/select the text above and copy it manually/i)).toBeInTheDocument();
        expect(screen.getByLabelText('Passage brief text — copy and send it yourself')).toHaveAttribute('readonly');
    });
});
