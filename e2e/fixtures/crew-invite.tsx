/**
 * Crew invite · layout fixture (126-B4). The real InviteCrewModal and the real
 * Edit Access form (EditCrewAccessForm), each inside the real ModalSheet, with
 * the app's CSS and a copy of the tab bar. Fictional crew only: skipper of the
 * Kestrel inviting Kenji Mori; Ana Ribeiro's access being edited.
 *
 * No network at all: every fetch is refused here, and storage is page-only.
 *
 * ?screen=invite|edit  &mode=dark|light  &pane=true (the iPad split pane,
 * 507 x 640, beside a companion page)  &ticked=documents,passage_checklist
 */
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CrewMember, CrewRole, SharedRegister } from '../../services/CrewService';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The crew-invite fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Crew-invite fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
const screenName = params.get('screen') === 'edit' ? 'edit' : 'invite';
const mode = params.get('mode') === 'light' ? 'light' : 'dark';
const pane = params.get('pane') === 'true';
const ticked = (params.get('ticked') ?? 'documents,passage_checklist').split(',').filter(Boolean) as SharedRegister[];
document.documentElement.classList.toggle('display-light', mode === 'light');

const [{ InviteCrewModal }, { EditCrewAccessForm }, { ModalSheet }, { PanePortalScope }, identity] = await Promise.all([
    import('../../components/crew/InviteCrewModal'),
    import('../../components/crewManagement/EditCrewAccessForm'),
    import('../../components/ui/ModalSheet'),
    import('../../context/PanePortalContext'),
    import('../../services/authIdentityScope'),
]);
const scope = identity.setAuthIdentityScope('4b2d9c1e-7f3a-4e5b-9c8d-1a2b3c4d5e6f');

const ANA = {
    id: '6c5d4e3f-2a1b-4c9d-8e7f-0a1b2c3d4e5f',
    owner_id: scope.userId,
    crew_user_id: '8e7f6a5b-4c3d-4b2a-9f1e-0d9c8b7a6f5e',
    crew_email: 'ana.ribeiro@example.com',
    owner_email: 'skipper@example.com',
    role: 'deckhand',
    status: 'accepted',
    shared_registers: ticked,
} as unknown as CrewMember;

function InviteSheet() {
    const [email, setEmail] = useState('kenji.mori@example.com');
    const [role, setRole] = useState<CrewRole>('deckhand');
    const [registers, setRegisters] = useState<SharedRegister[]>(ticked);
    return (
        <ModalSheet isOpen onClose={() => undefined} title="Invite Crew Member">
            <InviteCrewModal
                inviteEmail={email}
                inviteRole={role}
                inviteRegisters={registers}
                inviteLoading={false}
                inviteError={null}
                inviteSuccess={false}
                onEmailChange={setEmail}
                onRoleChange={setRole}
                onToggleRegister={(register) =>
                    setRegisters((list) =>
                        list.includes(register) ? list.filter((r) => r !== register) : [...list, register],
                    )
                }
                onInvite={() => undefined}
                onDone={() => undefined}
            />
        </ModalSheet>
    );
}

function EditSheet() {
    const [prefix, setPrefix] = useState('');
    const [first, setFirst] = useState('Ana');
    const [last, setLast] = useState('Ribeiro');
    const [nickname, setNickname] = useState('');
    const [registers, setRegisters] = useState<SharedRegister[]>(ticked);
    return (
        <ModalSheet isOpen onClose={() => undefined} title={`Edit Access — ${ANA.crew_email}`}>
            <EditCrewAccessForm
                editBoatMemberLoaded
                editPrefix={prefix}
                setEditPrefix={setPrefix}
                editFirstName={first}
                setEditFirstName={setFirst}
                editLastName={last}
                setEditLastName={setLast}
                editNickname={nickname}
                setEditNickname={setNickname}
                editTarget={ANA}
                editRegisters={registers}
                setEditRegisters={setRegisters}
                toggleRegister={(register, list, setList) =>
                    setList(list.includes(register) ? list.filter((r) => r !== register) : [...list, register])
                }
                handleSavePermissions={async () => undefined}
                onRemove={() => undefined}
                scopeStillOwnsPage={() => true}
                renderScope={scope}
            />
        </ModalSheet>
    );
}

function Fixture() {
    const frame = useRef<HTMLElement>(null);
    return (
        <main className="relative flex h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            <div className={`flex min-h-0 w-full flex-1 ${pane ? 'gap-2 p-2' : ''}`}>
                {pane && (
                    <aside
                        className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4 text-slate-300"
                        aria-label="Companion pane"
                    >
                        The Glass (companion pane)
                    </aside>
                )}
                <PanePortalScope enabled={pane} paneId="crew-invite-fixture" frameRef={frame}>
                    <section
                        ref={frame}
                        data-split-pane={pane ? 'crew-invite-fixture' : undefined}
                        className={
                            pane
                                ? 'relative shrink-0 overflow-hidden rounded-2xl border border-white/25 bg-slate-950'
                                : 'absolute inset-0'
                        }
                        style={pane ? { width: 507, height: 640 } : undefined}
                    >
                        <div className="p-4">
                            <h1 className="ui-page-title">Crew &amp; Float Plan</h1>
                        </div>
                        {screenName === 'edit' ? <EditSheet /> : <InviteSheet />}
                    </section>
                </PanePortalScope>
            </div>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
            <nav
                aria-label="Main"
                data-testid="app-bottom-nav"
                className="fixed right-0 bottom-0 left-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{
                    background: mode === 'light' ? '#f8fafc' : 'rgb(10, 15, 20)',
                    borderColor: 'rgba(56, 189, 248, 0.12)',
                }}
            >
                <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-400">
                    <span>The Glass</span>
                    <span>Obs</span>
                    <span>Plan</span>
                    <span>Log</span>
                    <span className="text-sky-400">Vessel</span>
                </div>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { __crewInviteFixtureReady: true });
