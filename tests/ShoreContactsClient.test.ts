import { beforeEach, describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), satellite: false }));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mock.rpc, functions: { invoke: mock.invoke } } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.satellite }));
import {
    listShoreContacts,
    configureShoreContact,
    inviteShoreContact,
    parseShoreContacts,
    bindShoreAnchor,
} from '../services/shoreContactsClient';
import { parseShoreConfiguration, privateTelegramSender, shoreBotCommand } from '../utils/shoreContacts';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { takeShoreConsentLink } from '../services/shoreConsentLink';
import { readFileSync } from 'node:fs';
const owner = '10000000-0000-4000-8000-000000000001',
    boat = '20000000-0000-4000-8000-000000000001',
    id = '30000000-0000-4000-8000-000000000001',
    revision = '40000000-0000-4000-8000-000000000001';
const configuration = () => ({
    channel: 'email' as const,
    label: 'Personal contact',
    address: 'person@example.invalid',
    sharePosition: false,
    enabled: false,
});
const row = () => ({ id, revision, configuration: configuration(), consent: 'pending' as const, consentedAt: null });
const list = () => ({
    schema: 1,
    ownerId: owner,
    boatId: boat,
    checkedAt: Date.now(),
    emailReady: false,
    telegramReady: false,
    contacts: [row()],
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.rpc.mockReset();
    mock.invoke.mockReset();
    mock.satellite = false;
});
describe('private shore-contact source boundary', () => {
    it('requires exact contact configuration; no email position share, username or URL authority', () => {
        expect(parseShoreConfiguration(configuration())).not.toBeNull();
        for (const change of [
            { address: 'person\r\n@example.invalid' },
            { channel: 'telegram', address: '@someone' },
            { sharePosition: true },
            { url: 'https://bad.invalid' },
            { enabled: 'true' },
            { label: 'x'.repeat(61) },
        ])
            expect(parseShoreConfiguration({ ...configuration(), ...change })).toBeNull();
        expect(
            parseShoreConfiguration({ ...configuration(), channel: 'telegram', address: null, sharePosition: true }),
        ).not.toBeNull();
    });
    it('private Telegram identity uses numeric stable IDs and original message date', () => {
        const v = {
            update_id: 9,
            message: {
                chat: { id: 123, type: 'private' },
                from: { id: 123, is_bot: false },
                text: '/where',
                date: 1000,
            },
        };
        expect(privateTelegramSender(v)?.at).toBe(1000000);
        expect(
            privateTelegramSender({ ...v, message: { ...v.message, chat: { id: 123, type: 'supergroup' } } }),
        ).toBeNull();
        expect(shoreBotCommand('/stop')).toEqual({ kind: 'stop' });
        expect(shoreBotCommand('/where 123')).toBeNull();
    });
    it('refuses another hull/owner, future/stale response, extra fields and more than ten contacts', () => {
        const scope = getAuthIdentityScope();
        expect(parseShoreContacts(list(), boat, scope)).not.toBeNull();
        for (const patch of [
            { ownerId: id },
            { boatId: id },
            { checkedAt: Date.now() - 61000 },
            { checkedAt: Date.now() + 1000 },
            { contacts: Array.from({ length: 11 }, () => row()) },
            { rawPositions: [] },
            { contacts: [{ ...row(), chatId: '123' }] },
            { contacts: [{ ...row(), consent: 'confirmed', consentedAt: null }] },
        ])
            expect(parseShoreContacts({ ...list(), ...patch }, boat, scope)).toBeNull();
    });
    it('no background or explicit WAN in Satellite Mode', async () => {
        mock.satellite = true;
        const scope = getAuthIdentityScope();
        expect(await listShoreContacts(boat)).toBeNull();
        await expect(configureShoreContact(boat, null, configuration(), scope)).rejects.toThrow();
        await expect(inviteShoreContact(boat, row(), scope)).rejects.toThrow();
        await expect(bindShoreAnchor(boat, 'ABCDEFGHJKLM', null, scope)).rejects.toThrow();
        expect(mock.rpc).not.toHaveBeenCalled();
        expect(mock.invoke).not.toHaveBeenCalled();
    });
    it('drops late list, invite and write completions after owner changes', async () => {
        for (const kind of ['list', 'invite', 'save'] as const) {
            setAuthIdentityScope(owner);
            const scope = getAuthIdentityScope();
            let done!: (v: unknown) => void;
            const deferred = new Promise((r) => {
                done = r;
            });
            mock.rpc.mockReturnValue(deferred);
            mock.invoke.mockReturnValue(deferred);
            const pending =
                kind === 'list'
                    ? listShoreContacts(boat, scope)
                    : kind === 'invite'
                      ? inviteShoreContact(boat, row(), scope)
                      : configureShoreContact(boat, row(), configuration(), scope);
            setAuthIdentityScope(id);
            done({
                data: kind === 'list' ? list() : kind === 'invite' ? { invitationAccepted: true } : revision,
                error: null,
            });
            if (kind === 'list') expect(await pending).toBeNull();
            else await expect(pending).rejects.toThrow('changed');
        }
    });
    it('uses exact CAS and never retries an overwrite conflict', async () => {
        mock.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(configureShoreContact(boat, row(), configuration(), getAuthIdentityScope())).rejects.toThrow(
            'another phone',
        );
        expect(mock.rpc).toHaveBeenCalledTimes(1);
        expect(mock.rpc).toHaveBeenCalledWith('configure_shore_contact', {
            p_boat_id: boat,
            p_contact_id: id,
            p_expected: revision,
            p_configuration: configuration(),
        });
    });
    it('does not accept owner-visible email nonce or arbitrary Telegram response link', async () => {
        mock.invoke.mockResolvedValue({ data: { invitationUrl: 'https://bad.invalid/?token=secret' }, error: null });
        await expect(inviteShoreContact(boat, row(), getAuthIdentityScope())).rejects.toThrow();
        const tg = { ...row(), configuration: { ...configuration(), channel: 'telegram' as const, address: null } };
        await expect(inviteShoreContact(boat, tg, getAuthIdentityScope())).rejects.toThrow();
        mock.invoke.mockResolvedValue({
            data: { invitationUrl: 'https://t.me/fixture_bot?start=' + 'a'.repeat(64) },
            error: null,
        });
        expect(await inviteShoreContact(boat, tg, getAuthIdentityScope())).toContain('https://t.me/fixture_bot?start=');
    });
    it('email bearer fragments are removed without requests or persistent storage', () => {
        const history = { replaceState: vi.fn() };
        expect(
            takeShoreConsentLink({ hash: '#shore=confirm.' + 'a'.repeat(64), pathname: '/', search: '' }, history),
        ).toEqual({ action: 'confirm', nonce: 'a'.repeat(64) });
        expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
        history.replaceState.mockClear();
        for (const hash of [
            '#shore=confirm.bad',
            '#shore=confirm.' + 'a'.repeat(64) + '&owner=x',
            '#other=confirm.' + 'a'.repeat(64),
        ])
            expect(takeShoreConsentLink({ hash, pathname: '/', search: '' }, history)).toBeNull();
        expect(history.replaceState).not.toHaveBeenCalled();
        expect(mock.invoke).not.toHaveBeenCalled();
    });
    it('clears bearer URL before import-time Sentry/flight recorder initialization', () => {
        const boot = readFileSync('index.tsx', 'utf8');
        expect(boot.indexOf("import './services/shoreConsentLink'")).toBeLessThan(
            boot.indexOf("from './services/sentry'"),
        );
        const source = readFileSync('services/shoreConsentLink.ts', 'utf8');
        expect(source).not.toMatch(/\b(localStorage|sessionStorage|console|fetch|Sentry)\s*\./);
    });
});
