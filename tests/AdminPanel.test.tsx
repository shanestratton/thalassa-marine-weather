/**
 * AdminPanel — smoke tests (816 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ChatService', () => ({
    ChatService: {
        listAllUsersWithRoles: vi.fn().mockResolvedValue([]),
        getChannelsFresh: vi.fn().mockResolvedValue([]),
        updateRole: vi.fn().mockResolvedValue(undefined),
        deleteChannel: vi.fn().mockResolvedValue(undefined),
        getPendingJoinRequests: vi.fn().mockResolvedValue([]),
        approveJoinRequest: vi.fn().mockResolvedValue(undefined),
        rejectJoinRequest: vi.fn().mockResolvedValue(undefined),
        getAuditLog: vi.fn().mockResolvedValue([]),
        blockUserPlatform: vi.fn().mockResolvedValue(true),
        getCurrentUserId: vi.fn().mockReturnValue('test-admin-id'),
        getRole: vi.fn().mockReturnValue('admin'),
        isAdmin: vi.fn().mockReturnValue(true),
        isMod: vi.fn().mockReturnValue(false),
        isModerator: vi.fn().mockReturnValue(false),
    },
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../components/ui/ConfirmDialog', () => ({
    ConfirmDialog: () => null,
}));

vi.mock('../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { AdminPanel } from '../components/AdminPanel';

describe('AdminPanel', () => {
    const defaultProps = {
        isOpen: true,
        onClose: vi.fn(),
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing when open', () => {
        const { container } = render(<AdminPanel {...defaultProps} />);
        expect(container).toBeDefined();
    });

    it('renders content when open', () => {
        const { container } = render(<AdminPanel {...defaultProps} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('renders when closed without crashing', () => {
        const { container } = render(<AdminPanel {...defaultProps} isOpen={false} />);
        expect(container).toBeDefined();
    });

    it('accepts callback props', () => {
        expect(() => {
            render(<AdminPanel {...defaultProps} onChannelDeleted={vi.fn()} onChannelApproved={vi.fn()} />);
        }).not.toThrow();
    });
});
