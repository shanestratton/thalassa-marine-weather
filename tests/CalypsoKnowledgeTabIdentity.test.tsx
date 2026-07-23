import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getKnowledge: vi.fn(),
    addKnowledge: vi.fn(),
    updateKnowledge: vi.fn(),
    deleteKnowledge: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../services/CalypsoKnowledgeService', async () => {
    const actual = await vi.importActual<typeof import('../services/CalypsoKnowledgeService')>(
        '../services/CalypsoKnowledgeService',
    );
    return {
        ...actual,
        getKnowledge: mocks.getKnowledge,
        addKnowledge: mocks.addKnowledge,
        updateKnowledge: mocks.updateKnowledge,
        deleteKnowledge: mocks.deleteKnowledge,
    };
});

vi.mock('../components/Toast', () => ({
    toast: {
        success: mocks.toastSuccess,
        error: mocks.toastError,
    },
}));

import { CalypsoKnowledgeTab } from '../components/settings/CalypsoKnowledgeTab';

const ownerSettings = { subscriptionTier: 'owner' } as UserSettings;

function knowledge(userId: string, title: string) {
    return {
        id: `${userId}-note`,
        user_id: userId,
        category: 'general' as const,
        title,
        body: `${title} body`,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

describe('CalypsoKnowledgeTab account boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('knowledge-tab-a');
        mocks.getKnowledge.mockResolvedValue([knowledge('knowledge-tab-a', 'Account A private note')]);
        mocks.addKnowledge.mockResolvedValue(knowledge('knowledge-tab-a', 'Saved A note'));
        mocks.updateKnowledge.mockResolvedValue(true);
        mocks.deleteKnowledge.mockResolvedValue(true);
    });

    it('synchronously hides A notes while a deferred B load is pending', async () => {
        let resolveB!: (rows: ReturnType<typeof knowledge>[]) => void;
        const view = render(<CalypsoKnowledgeTab settings={ownerSettings} onSave={vi.fn()} />);
        expect(await screen.findByText('Account A private note')).toBeInTheDocument();

        mocks.getKnowledge.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveB = resolve;
            }),
        );
        act(() => {
            setAuthIdentityScope('knowledge-tab-b');
        });

        expect(screen.queryByText('Account A private note')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Loading Calypso knowledge')).toBeInTheDocument();

        await act(async () => {
            resolveB([knowledge('knowledge-tab-b', 'Account B private note')]);
            await Promise.resolve();
        });
        expect(await screen.findByText('Account B private note')).toBeInTheDocument();
        expect(view.container).not.toHaveTextContent('Account A private note');
    });

    it('drops a deferred A add completion after B becomes active', async () => {
        let resolveAdd!: (value: ReturnType<typeof knowledge>) => void;
        mocks.getKnowledge.mockResolvedValue([]);
        mocks.addKnowledge.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveAdd = resolve;
            }),
        );
        render(<CalypsoKnowledgeTab settings={ownerSettings} onSave={vi.fn()} />);
        await screen.findByText(/Nothing yet/);

        fireEvent.click(screen.getByRole('button', { name: /Add something Calypso should know/ }));
        fireEvent.change(screen.getByPlaceholderText(/Title/), { target: { value: 'A secret' } });
        fireEvent.change(screen.getByPlaceholderText(/Details/), { target: { value: 'Only A should see this' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));

        act(() => {
            setAuthIdentityScope('knowledge-tab-b');
        });
        await act(async () => {
            resolveAdd(knowledge('knowledge-tab-a', 'A secret'));
            await Promise.resolve();
        });

        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(screen.queryByDisplayValue('A secret')).not.toBeInTheDocument();
        expect(screen.queryByText('A secret')).not.toBeInTheDocument();
    });
});
