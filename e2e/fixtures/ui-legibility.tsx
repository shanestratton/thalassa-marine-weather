/** Shared production components with local state only: no accounts or vessel data. */
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PageHeader } from '../../components/ui/PageHeader';
import { FormField } from '../../components/ui/FormField';
import { Section, Row } from '../../components/settings/SettingsPrimitives';
import { Button } from '../../components/ui/Button';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import { useThemeStore } from '../../stores/themeStore';
import { getThemeForEnvironment } from '../../theme';
import '../../index.css';
// Passage styles can load after shared UI in the app.
import '../../styles/bioluminescent.css';

function Fixture() {
    const [mode, setMode] = useState<'light' | 'dark' | 'night'>('light');
    const [environment, setEnvironment] = useState<'offshore' | 'onshore'>('offshore');
    const [name, setName] = useState('Thalassa');
    const [sheetOpen, setSheetOpen] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', mode === 'light');
        document.documentElement.classList.toggle('theme-onshore', environment === 'onshore');
        useThemeStore.setState({ environment, theme: getThemeForEnvironment(environment) });
    }, [mode, environment]);

    return (
        <main
            className="min-h-screen bg-slate-950 text-white"
            data-testid="ui-background"
            data-mode={mode}
            data-environment={environment}
        >
            <nav className="flex flex-wrap gap-2 p-2" aria-label="Fixture display mode">
                {(['light', 'dark', 'night'] as const).map((value) => (
                    <button key={value} className="border border-white/20 p-2" onClick={() => setMode(value)}>
                        {value}
                    </button>
                ))}
                <button
                    className="border border-white/20 p-2"
                    onClick={() => setEnvironment((value) => (value === 'offshore' ? 'onshore' : 'offshore'))}
                >
                    Toggle environment
                </button>
            </nav>

            <div data-testid="ui-pane" className="w-full max-w-[669px] p-2 space-y-3">
                <section data-testid="header-card" className="rounded-2xl bg-slate-800 border border-white/10">
                    <PageHeader title="Vessel details" subtitle="Registration & equipment" />
                </section>
                <section
                    data-testid="form-card"
                    className="rounded-2xl bg-slate-800 border border-white/10 p-4 space-y-4"
                >
                    <FormField label="Vessel name" value={name} onChange={setName} required />
                    <FormField
                        label="Registration"
                        value="AB123Q"
                        onChange={() => {}}
                        hint="Use the number on your certificate."
                    />
                    <FormField
                        label="Assigned berth"
                        value="Marina office only"
                        onChange={() => {}}
                        disabled
                        className="disabled:opacity-50"
                    />
                    <FormField
                        label="Emergency contact"
                        value=""
                        onChange={() => {}}
                        error="Add a contact before departure."
                        hint="This hint must yield to the error."
                    />
                    <Button disabled className="w-full opacity-40" data-testid="disabled-save">
                        Save while offline
                    </Button>
                </section>
                <section data-testid="settings-card" className="rounded-2xl bg-slate-800 border border-white/10 p-4">
                    <Section title="Safety reminders">
                        <Row>
                            <div>
                                <p className="ui-field-label">Equipment checks</p>
                                <p className="ui-caption">Review before every voyage.</p>
                            </div>
                        </Row>
                    </Section>
                    <h3 className="ui-section-heading text-amber-400" data-testid="warning-heading">
                        Safety notice
                    </h3>
                    <p className="text-micro font-medium text-amber-400" data-testid="warning-caption">
                        Check expiry before departure.
                    </p>
                </section>
                <section
                    data-testid="interaction-card"
                    className="rounded-2xl bg-slate-800 border border-white/10 p-4 flex flex-wrap gap-2"
                >
                    <button className="text-micro text-gray-500 hover:text-red-400 p-2" data-testid="danger-hover">
                        Delete draft
                    </button>
                    <button className="group p-2" data-testid="accent-hover">
                        <span className="text-micro text-gray-500 group-hover:text-sky-400">View equipment</span>
                    </button>
                    <button
                        className="rounded-xl bg-sky-600 text-white hover:text-white p-3"
                        data-testid="filled-action"
                    >
                        Save changes
                    </button>
                    <Button variant="primary" data-testid="primary-action">
                        Save vessel
                    </Button>
                </section>
                <div className="flex gap-2">
                    <Button onClick={() => setSheetOpen(true)}>Open details</Button>
                    <Button onClick={() => setConfirmOpen(true)}>Open confirmation</Button>
                </div>
            </div>

            <ModalSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} title="Equipment details">
                <FormField
                    label="Item name"
                    value="Life jackets"
                    onChange={() => {}}
                    hint="Count every size on board."
                />
            </ModalSheet>
            <ConfirmDialog
                isOpen={confirmOpen}
                title="Remove reminder?"
                message="This removes the selected equipment reminder."
                confirmLabel="Remove"
                destructive
                onConfirm={() => setConfirmOpen(false)}
                onCancel={() => setConfirmOpen(false)}
            />
            {mode === 'night' && (
                <div
                    data-testid="night-scrim"
                    className="fixed inset-0 pointer-events-none touch-none"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                    aria-hidden="true"
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
