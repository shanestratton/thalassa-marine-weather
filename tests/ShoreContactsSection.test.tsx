import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    list: vi.fn(),
    save: vi.fn(),
    invite: vi.fn(),
    bind: vi.fn(),
    state: { activeVesselId: '20000000-0000-4000-8000-000000000001' },
}));
vi.mock('../services/shoreContactsClient', () => ({
    listShoreContacts: mock.list,
    configureShoreContact: mock.save,
    inviteShoreContact: mock.invite,
    bindShoreAnchor: mock.bind,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((select: (s: typeof mock.state) => unknown) => select(mock.state), {
        getState: () => mock.state,
    }),
}));
import ShoreContactsSection from '../components/settings/ShoreContactsSection';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const owner = '10000000-0000-4000-8000-000000000001',
    id = '30000000-0000-4000-8000-000000000001',
    revision = '40000000-0000-4000-8000-000000000001';
const data = (ready = false, confirmed = false, enabled = false) => ({
    schema: 1,
    ownerId: owner,
    boatId: mock.state.activeVesselId,
    checkedAt: Date.now(),
    emailReady: ready,
    telegramReady: ready,
    contacts: [
        {
            id,
            revision,
            configuration: {
                channel: 'email',
                label: 'Private personal contact',
                address: 'personal@example.invalid',
                enabled,
                sharePosition: false,
            },
            consent: confirmed ? 'confirmed' : 'pending',
            consentedAt: confirmed ? Date.now() - 1000 : null,
        },
    ],
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.list.mockReset().mockResolvedValue(data());
    mock.save.mockReset().mockResolvedValue(undefined);
    mock.invite.mockReset().mockResolvedValue(null);
    mock.bind.mockReset();
});
it('hides new opt-ins until actual capability but preserves an existing stop control', async () => {
    mock.list.mockResolvedValue({ ...data(), contacts: [] });
    const a = render(<ShoreContactsSection />);
    await act(async () => {});
    expect(screen.queryByText('Personal shore contacts')).toBeNull();
    a.unmount();
    mock.list.mockResolvedValue(data(false, true, true));
    render(<ShoreContactsSection />);
    await act(async () => {});
    const stop = screen.getByRole('button', { name: 'Stop this contact' });
    expect(stop).toBeEnabled();
    await act(async () => fireEvent.click(stop));
    expect(mock.save.mock.calls[0][2].enabled).toBe(false);
});
it('confirmation and owner enabling are distinct; viewing/inviting never enables delivery', async () => {
    mock.list.mockResolvedValue(data(true, false));
    render(<ShoreContactsSection />);
    await act(async () => {});
    expect(mock.save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enable confirmed contact' })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Invite again / renew consent' })));
    expect(mock.invite).toHaveBeenCalledTimes(1);
    expect(mock.save).not.toHaveBeenCalled();
    mock.list.mockResolvedValue(data(true, true));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reload contacts' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable confirmed contact' })));
    expect(mock.save.mock.calls[0][2].enabled).toBe(true);
});
it('new contacts start off and email cannot acquire /where position permission', async () => {
    mock.list.mockResolvedValue({ ...data(true), contacts: [] });
    render(<ShoreContactsSection />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Contact label'), { target: { value: 'New friend' } });
    fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'friend@example.invalid' } });
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save contact off' })));
    expect(mock.save.mock.calls[0][2]).toEqual({
        channel: 'email',
        label: 'New friend',
        address: 'friend@example.invalid',
        sharePosition: false,
        enabled: false,
    });
});
it('account changes immediately hide contacts/private draft and reject old invitation completions', async () => {
    mock.list.mockResolvedValue(data(true));
    let done!: (url: string) => void;
    mock.invite.mockImplementation(
        () =>
            new Promise((r) => {
                done = r;
            }),
    );
    render(<ShoreContactsSection />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Contact label'), { target: { value: 'Private draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite again / renew consent' }));
    mock.list.mockResolvedValue(null);
    await act(async () => setAuthIdentityScope('10000000-0000-4000-8000-000000000099'));
    expect(screen.queryByText('Private personal contact')).toBeNull();
    expect(screen.queryByDisplayValue('Private draft')).toBeNull();
    await act(async () => done('https://t.me/fixture_bot?start=' + 'a'.repeat(64)));
    expect(screen.queryByDisplayValue(/https:\/\/t.me/)).toBeNull();
});
