/**
 * CrewManagement — smoke tests (809 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../theme', () => ({
    t: {
        colors: {
            bg: { base: '#0f172a', elevated: '#1e293b', card: '#1e293b' },
            text: { primary: '#f8fafc', secondary: '#94a3b8', muted: '#64748b' },
            border: { subtle: '#334155', muted: '#1e293b' },
            accent: { primary: '#0ea5e9', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444' },
        },
        nav: { pageBackground: '#0f172a' },
        card: { background: '#1e293b', border: '#334155' },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
        radius: { sm: 8, md: 12, lg: 16 },
        typography: { caption: { fontSize: 11 }, label: { fontSize: 12 }, body: { fontSize: 14 } },
    },
    default: { colors: { bg: { base: '#0f172a' } } },
}));

vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
        isOpen ? <div data-testid="modal-sheet">{children}</div> : null,
}));

vi.mock('../components/ui/UndoToast', () => ({
    UndoToast: () => null,
}));

vi.mock('../services/CrewService', () => ({
    ALL_REGISTERS: ['log', 'stores', 'maintenance'],
    REGISTER_LABELS: { log: 'Ship Log', stores: 'Stores', maintenance: 'Maintenance' },
    REGISTER_ICONS: { log: '📋', stores: '📦', maintenance: '🔧' },
    inviteCrew: vi.fn().mockResolvedValue(undefined),
    getMyCrew: vi.fn().mockResolvedValue([]),
    removeCrew: vi.fn().mockResolvedValue(undefined),
    updateCrewPermissions: vi.fn().mockResolvedValue(undefined),
    getMyInvites: vi.fn().mockResolvedValue([]),
    getMyMemberships: vi.fn().mockResolvedValue([]),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    declineInvite: vi.fn().mockResolvedValue(undefined),
    leaveVessel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/keyboardScroll', () => ({ scrollInputAboveKeyboard: vi.fn() }));
vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: (fn: () => Promise<any>) => React.lazy(fn),
}));
vi.mock('../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../components/AuthModal', () => ({
    AuthModal: () => null,
}));
vi.mock('../components/crew/SwipeableCrewCard', () => ({
    SwipeableCrewCard: () => <div data-testid="crew-card">Crew Card</div>,
}));

import { CrewManagement } from '../components/CrewManagement';

describe('CrewManagement', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<CrewManagement onBack={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<CrewManagement onBack={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it('accepts onBack callback', () => {
        expect(() => {
            render(<CrewManagement onBack={vi.fn()} />);
        }).not.toThrow();
    });
});
