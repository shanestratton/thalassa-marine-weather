/**
 * Binder sheets fit one screen (132-B19).
 *
 * The Add/Edit sheets for Equipment, Documents, Maintenance and Stores put
 * Save at the end of their scroll, below the fold on an SE; their category
 * chips put icon and word on one line in a third of the sheet, and ran out of
 * their pills at 320 px in wide fonts. Now:
 *
 *  - ModalSheet takes a footer: the main button pinned below the fields, which
 *    scroll above it in a box of their own;
 *  - every binder sheet picks its category (and Maintenance its schedule) on
 *    the Stores grid, three across, the label wrapping under the icon;
 *  - the notes are folded away until asked for, and open when there are some;
 *  - the seeded Maintenance tasks say 'weed', not 'Newport weed', and name the
 *    residual-current device in full;
 *  - every binder page and sheet has a browser spec that CI runs.
 *
 * The geometry itself (Save on screen at 320 x 568 and 375 x 667 in wide
 * fonts, nothing clipped, nothing sideways) is measured in the browser specs
 * named below; this pins the structure that does it. Fictional gear only.
 */
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentCategory, EquipmentItem } from '../types';

const mocks = vi.hoisted(() => ({ rows: [] as EquipmentItem[], create: vi.fn() }));

vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: {
        getAll: vi.fn(() => mocks.rows),
        create: mocks.create,
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: { getDownloadUrl: vi.fn(), openDownload: vi.fn() },
}));
vi.mock('../services/vessel/LocalDatabase', () => ({ generateUUID: vi.fn(() => 'id'), getById: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn() }));

import { ModalSheet } from '../components/ui/ModalSheet';
import { BinderCategoryGrid } from '../components/vessel/BinderCategoryGrid';
import { FoldedNotes } from '../components/vessel/FoldedNotes';
import { EquipmentList } from '../components/vessel/EquipmentList';
import { DocumentForm, DocumentFormSave } from '../components/vessel/documents/DocumentForm';
import { TaskFormModal } from '../components/vessel/maintenance/TaskFormModal';
import { DEFAULT_MAINTENANCE_TASKS } from '../components/vessel/maintenance/defaultTasks';
import { useMaintenanceForm } from '../hooks/useMaintenanceForm';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';
import { GearIcon } from '../components/icons/UIIcons';

// The sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** The sheet's scrolling body and its pinned footer, from the dialog the test found. */
function parts(dialog: HTMLElement) {
    const panel = dialog.querySelector<HTMLElement>('[data-modal-sheet]')!;
    return {
        panel,
        body: panel.querySelector<HTMLElement>('[data-modal-sheet-body]'),
        footer: panel.querySelector<HTMLElement>('[data-modal-sheet-footer]'),
    };
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
    mocks.rows = [];
    mocks.create.mockReset().mockResolvedValue({ id: 'equipment-new' });
});

describe('ModalSheet keeps its main button in view', () => {
    it('with a footer: the fields scroll in their own box, the footer is pinned below it', () => {
        render(
            <ModalSheet isOpen onClose={vi.fn()} title="Add equipment" footer={<button>Register equipment</button>}>
                <input aria-label="Equipment name" />
            </ModalSheet>,
        );
        const { panel, body, footer } = parts(screen.getByRole('dialog', { name: 'Add equipment' }));
        // The panel no longer scrolls; its body does, and the footer sits after it.
        expect(panel).toHaveClass('flex', 'flex-col', 'overflow-hidden');
        expect(panel).not.toHaveClass('overflow-y-auto');
        expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
        expect(footer).toHaveClass('flex-none');
        expect(body!.nextElementSibling).toBe(footer);
        expect(within(body!).getByRole('textbox', { name: 'Equipment name' })).toBeInTheDocument();
        expect(within(body!).getByRole('heading', { name: 'Add equipment' })).toBeInTheDocument();
        expect(within(body!).getByRole('button', { name: 'Close' })).toBeInTheDocument();
        expect(within(footer!).getByRole('button', { name: 'Register equipment' })).toBeInTheDocument();
    });

    it('the focus trap reaches the footer: Shift+Tab from Close lands on it', () => {
        render(
            <ModalSheet isOpen onClose={vi.fn()} title="Edit task" footer={<button>Save changes</button>}>
                <input aria-label="Task name" />
            </ModalSheet>,
        );
        const close = screen.getByRole('button', { name: 'Close' });
        close.focus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus();
    });

    it('without one, every other sheet is as it was: the panel itself scrolls', () => {
        render(
            <ModalSheet isOpen onClose={vi.fn()} title="Service history">
                <p>No service history</p>
            </ModalSheet>,
        );
        const { panel, body, footer } = parts(screen.getByRole('dialog', { name: 'Service history' }));
        expect(panel).toHaveClass('p-5', 'overflow-y-auto');
        expect(body).toBeNull();
        expect(footer).toBeNull();
    });
});

describe('the Stores grid, for every binder sheet', () => {
    it('three across, icons above wrapping labels, each spoken by its name, one pressed', () => {
        const change = vi.fn();
        render(
            <BinderCategoryGrid
                label="Equipment category"
                choices={[
                    { id: 'Propulsion', label: 'Propulsion', Icon: GearIcon, name: 'Select Propulsion category' },
                    { id: 'Electronics', label: 'Electronics', Icon: GearIcon, name: 'Select Electronics category' },
                ]}
                value="Propulsion"
                onChange={change}
            />,
        );
        const grid = screen.getByRole('group', { name: 'Equipment category' });
        expect(grid).toHaveClass('grid', 'grid-cols-3');
        const electronics = within(grid).getByRole('button', { name: 'Select Electronics category' });
        expect(electronics).toHaveTextContent('Electronics');
        expect(electronics).toHaveClass('min-w-0', 'min-h-[56px]', 'flex-col');
        expect(electronics.querySelector('svg')).not.toBeNull();
        expect(electronics.querySelector('span')).toHaveClass('[overflow-wrap:anywhere]', 'text-balance');
        expect(electronics.querySelector('span')).not.toHaveClass('truncate');
        expect(within(grid).getByRole('button', { name: 'Select Propulsion category' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(electronics).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(electronics);
        expect(change).toHaveBeenCalledExactlyOnceWith('Electronics');
        // A button, never a submit: a tap picks, it never saves.
        expect(electronics).toHaveAttribute('type', 'button');
    });

    it('a choice with no icon (a schedule) is a 44 pt cell named by its words', () => {
        render(
            <BinderCategoryGrid
                label="Schedule"
                choices={[
                    { id: 'engine_hours', label: 'Engine hours' },
                    { id: 'bi_annual', label: 'Six-monthly' },
                ]}
                value="bi_annual"
                onChange={vi.fn()}
            />,
        );
        const six = within(screen.getByRole('group', { name: 'Schedule' })).getByRole('button', {
            name: 'Six-monthly',
        });
        expect(six).toHaveClass('min-h-[44px]');
        expect(six).not.toHaveClass('min-h-[56px]');
        expect(six.querySelector('svg')).toBeNull();
        expect(six).toHaveAttribute('aria-pressed', 'true');
    });
});

describe('notes, folded away until wanted', () => {
    function Host({ initial = '' }: { initial?: string }) {
        const [notes, setNotes] = React.useState(initial);
        return <FoldedNotes value={notes} onChange={setNotes} placeholder="Policy number, agent contact…" />;
    }

    it('none yet: one Add notes row, no empty box', () => {
        render(<Host />);
        expect(screen.getByRole('button', { name: 'Add notes' })).toBeInTheDocument();
        expect(screen.queryByLabelText('Notes (optional)')).toBeNull();
    });

    it('the tap opens the field with the cursor in it, and emptied it stays open', () => {
        render(<Host />);
        fireEvent.click(screen.getByRole('button', { name: 'Add notes' }));
        const field = screen.getByLabelText('Notes (optional)');
        expect(field).toHaveFocus();
        fireEvent.change(field, { target: { value: 'Policy KX-2231' } });
        fireEvent.change(field, { target: { value: '' } });
        expect(screen.getByLabelText('Notes (optional)')).toBe(field);
        expect(screen.queryByRole('button', { name: 'Add notes' })).toBeNull();
    });

    it('notes already written show open, not focused, and stay open when cleared', () => {
        render(<Host initial="Agent: Horta Marine" />);
        const field = screen.getByLabelText('Notes (optional)');
        expect(field).toHaveValue('Agent: Horta Marine');
        expect(field).not.toHaveFocus();
        fireEvent.change(field, { target: { value: '' } });
        expect(screen.getByLabelText('Notes (optional)')).toBeInTheDocument();
    });
});

describe('Equipment: Add and Edit', () => {
    it('Register equipment is pinned below the fields, the grid and the folded notes', async () => {
        render(<EquipmentList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Add equipment' }));
        const sheet = screen.getByRole('dialog', { name: 'Add equipment' });
        const { body, footer } = parts(sheet);

        const grid = within(body!).getByRole('group', { name: 'Equipment category' });
        expect(within(grid).getAllByRole('button')).toHaveLength(6);
        expect(within(grid).getByRole('button', { name: 'Select Propulsion category' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(within(body!).getByRole('button', { name: 'Add notes' })).toBeInTheDocument();
        expect(within(body!).queryByLabelText('Notes (optional)')).toBeNull();

        const register = within(footer!).getByRole('button', { name: 'Register new equipment' });
        expect(register).toBeDisabled();
        expect(within(footer!).getByText('Equipment name is required')).toBeInTheDocument();

        fireEvent.click(within(grid).getByRole('button', { name: 'Select Electronics category' }));
        fireEvent.change(within(body!).getByLabelText(/Equipment name/), { target: { value: 'Chartplotter' } });
        fireEvent.click(within(body!).getByRole('button', { name: 'Add notes' }));
        fireEvent.change(within(body!).getByLabelText('Notes (optional)'), {
            target: { value: 'Under the nav desk' },
        });
        expect(within(footer!).queryByText('Equipment name is required')).toBeNull();
        fireEvent.click(register);
        await vi.waitFor(() =>
            expect(mocks.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    equipment_name: 'Chartplotter',
                    category: 'Electronics',
                    notes: 'Under the nav desk',
                }),
            ),
        );
    });
});

describe('Documents: Add and Edit', () => {
    function Sheet({ name = '', notes = '', category = 'Registration' as DocumentCategory, busy = false }) {
        const save = vi.fn();
        return (
            <ModalSheet
                isOpen
                onClose={vi.fn()}
                title="Add document"
                footer={<DocumentFormSave isEdit={false} formName={name} fileBusy={busy} onSave={save} />}
            >
                <DocumentForm
                    formName={name}
                    formCategory={category}
                    formIssueDate=""
                    formExpiryDate=""
                    formNotes={notes}
                    formFileUri={null}
                    formFileName={null}
                    onNameChange={vi.fn()}
                    onCategoryChange={vi.fn()}
                    onIssueDateChange={vi.fn()}
                    onExpiryDateChange={vi.fn()}
                    onNotesChange={vi.fn()}
                    onFileSelect={vi.fn()}
                    onRemoveFile={vi.fn()}
                />
            </ModalSheet>
        );
    }

    it('Add document is pinned below the fields; the six categories are the Stores grid', () => {
        render(<Sheet />);
        const { body, footer } = parts(screen.getByRole('dialog', { name: 'Add document' }));
        const grid = within(body!).getByRole('group', { name: 'Document category' });
        expect(grid).toHaveClass('grid-cols-3');
        expect(within(grid).getAllByRole('button')).toHaveLength(6);
        expect(within(grid).getByRole('button', { name: 'Customs category' })).toHaveTextContent('Customs');
        expect(within(body!).getByRole('button', { name: 'Add notes' })).toBeInTheDocument();
        expect(within(footer!).getByRole('button', { name: 'Add document' })).toBeDisabled();
        expect(within(footer!).getByText('Document name is required')).toBeInTheDocument();
    });

    it('a named paper may be saved, unless its file is still being kept; notes written show open', () => {
        const { rerender } = render(<Sheet name="Hull insurance" notes="Policy KX-2231" />);
        const { body, footer } = parts(screen.getByRole('dialog', { name: 'Add document' }));
        expect(within(body!).getByLabelText('Notes (optional)')).toHaveValue('Policy KX-2231');
        expect(within(footer!).getByRole('button', { name: 'Add document' })).toBeEnabled();
        rerender(<Sheet name="Hull insurance" busy />);
        expect(screen.getByRole('button', { name: 'Add document' })).toBeDisabled();
    });
});

describe('Maintenance: New task and Edit task', () => {
    function Host({ mode }: { mode: 'add' | 'edit' }) {
        const f = useMaintenanceForm();
        return (
            <TaskFormModal
                mode={mode}
                form={f.form}
                setField={f.setField}
                setCategory={f.setCategory}
                setTaskType={f.setTaskType}
                setTrigger={f.setTrigger}
                engineHours={null}
                onSubmit={vi.fn()}
                onClose={vi.fn()}
            />
        );
    }

    it('New task: category and schedule on the Stores grid, notes folded, Create task pinned', () => {
        render(<Host mode="add" />);
        const { body, footer } = parts(screen.getByRole('dialog', { name: 'New task' }));
        const categories = within(body!).getByRole('group', { name: 'Task category' });
        // Repair is a type of its own, not a category to pick here.
        expect(
            within(categories)
                .getAllByRole('button')
                .map((b) => b.getAttribute('aria-label')),
        ).toEqual(['Engine', 'Safety', 'Hull', 'Rigging', 'Routine']);
        const schedule = within(body!).getByRole('group', { name: 'Schedule' });
        expect(
            within(schedule)
                .getAllByRole('button')
                .map((b) => b.textContent),
        ).toEqual(['Engine hours', 'Pre-trip', 'Quarterly', 'Monthly', 'Six-monthly', 'Annual']);
        expect(within(schedule).getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(within(schedule).getByRole('button', { name: 'Six-monthly' }));
        expect(within(schedule).getByRole('button', { name: 'Six-monthly' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(body!).getByRole('button', { name: 'Add notes' })).toBeInTheDocument();
        expect(within(footer!).getByRole('button', { name: 'Create task' })).toBeDisabled();
        expect(within(footer!).getByText('Enter a task name to continue')).toBeInTheDocument();
        fireEvent.change(within(body!).getByLabelText(/Task name/), { target: { value: 'Antifoul' } });
        expect(within(footer!).getByRole('button', { name: 'Create task' })).toBeEnabled();
    });

    it("Edit task: above the task's own sheet, six categories with Repair, Save changes pinned", () => {
        render(<Host mode="edit" />);
        const dialog = screen.getByRole('dialog', { name: 'Edit task' });
        // The task's sheet is OverlayPortal's 'modal' band (z-1100): Edit opens
        // from it, so it takes the 'nested' band, or it opens underneath.
        expect(dialog).toHaveClass('z-1200');
        const { body, footer } = parts(dialog);
        expect(within(within(body!).getByRole('group', { name: 'Task category' })).getAllByRole('button')).toHaveLength(
            6,
        );
        expect(within(body!).getByRole('group', { name: 'Schedule' })).toBeInTheDocument();
        expect(within(footer!).getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
        expect(within(body!).queryByRole('button', { name: 'Save changes' })).toBeNull();
    });
});

describe('Stores: Add and Edit', () => {
    // Their geometry is measured in browser-tests/stores-layout.spec.ts.
    it('both sheets pin their main button in the footer', () => {
        /** What a sheet passes as its footer: from `footer={` to its first field. */
        const footerOf = (source: string, title: string) => {
            const sheet = source.slice(source.indexOf(title));
            return sheet.slice(sheet.indexOf('footer={'), sheet.indexOf('<div className="space-y-2">'));
        };
        const add = footerOf(
            read('components/vessel/InventoryScanner.tsx'),
            "title={box ? `Add to ${box.name}` : 'Add item'}",
        );
        expect(add).toContain("{saving ? 'Adding…' : 'Add item'}");
        expect(add).toContain('aria-label="Cancel adding item"');
        const edit = footerOf(read('components/vessel/InventoryList.tsx'), 'title="Edit item"');
        expect(edit).toContain('aria-label="Save inventory item changes"');
    });
});

describe('the suggested tasks speak to every boat', () => {
    it("no marina's weed and no obsolete abbreviation", () => {
        const words = DEFAULT_MAINTENANCE_TASKS.map((task) => `${task.title} ${task.description}`).join('\n');
        expect(words).not.toMatch(/Newport/);
        expect(words).not.toMatch(/ELCB/);
        const strainer = DEFAULT_MAINTENANCE_TASKS.find((task) => task.title === 'Inspect Raw Water Strainer')!;
        expect(strainer.description).toBe('Check for weed, jellyfish, and debris. Clean basket if blocked.');
        const shore = DEFAULT_MAINTENANCE_TASKS.find((task) => task.title === 'Inspect Shore Power Lead & Plug')!;
        expect(shore.description).toContain('residual-current device (RCD)');
        // Still forty: the seed's count is what the toast and the guard read.
        expect(DEFAULT_MAINTENANCE_TASKS).toHaveLength(40);
    });
});

describe('a browser spec for every binder page and sheet, run in CI', () => {
    const SPECS = [
        'equipment-layout.spec.ts',
        'documents-sheet-layout.spec.ts',
        'maintenance-layout.spec.ts',
        'stores-layout.spec.ts',
        'checklists-layout.spec.ts',
        // The Stores grid's own spec, which had a config CI never ran.
        'stores-category-grid-layout.spec.ts',
    ];

    it('each spec exists and is in the keyboard config, which the CI shards run', () => {
        const config = read('playwright.keyboard.config.ts');
        for (const spec of SPECS) {
            expect(existsSync(resolve(process.cwd(), 'browser-tests', spec)), spec).toBe(true);
            expect(config, spec).toContain(`'${spec}'`);
        }
        expect(read('.github/workflows/full-checks.yml')).toContain(
            'npx playwright test --config playwright.keyboard.config.ts --shard=',
        );
    });

    it('the Stores grid has no config of its own left to forget', () => {
        expect(existsSync(resolve(process.cwd(), 'playwright.stores.config.ts'))).toBe(false);
    });

    it('the binder fixture is the dev server only, with no network', () => {
        const fixture = read('e2e/fixtures/binder-sheets.tsx');
        expect(fixture).toMatch(/if \(!import\.meta\.env\.DEV\)\s+throw new Error\(/);
        expect(fixture).toMatch(/window\.fetch = async \(\) =>/);
        expect(read('e2e/fixtures/binder-sheets.html')).toContain("connect-src 'self' ws://127.0.0.1:*");
    });

    it("the binder pages are measured under the app's own header, SKIPPER · BETA badge and all", () => {
        // In wide fonts the badge wraps under the wordmark at 320 and 375 px:
        // without it the header was ~19 px short and every page check had
        // room a skipper's phone does not (132-B19 review).
        const app = read('App.tsx');
        const fixture = read('e2e/fixtures/binder-sheets.tsx');
        const badge = app.match(/<span className="(thalassa-beta-badge [^"]+)">/)![1];
        const header = [
            // The 64 px mark, 48 under 390.
            'thalassa-header-logo',
            'w-[64px] h-[64px] max-[389px]:w-12 max-[389px]:h-12',
            // The wordmark and the badge in a row that wraps.
            'flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5',
            'shrink-0 whitespace-nowrap text-xl font-bold tracking-wider uppercase',
            'text-[11px] font-bold uppercase leading-none tracking-wider',
            // The tagline, and the status button's cluster.
            'flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200',
            'flex shrink-0 items-center gap-2 pointer-events-auto',
        ];
        for (const classes of header) {
            expect(app, classes).toContain(classes);
            expect(fixture, classes).toContain(classes);
        }
        // Every skipper sees the badge while the public beta is on.
        expect(PUBLIC_BETA_ACCESS.enabled).toBe(true);
        expect(app).toMatch(/\{PUBLIC_BETA_ACCESS\.enabled \? \(/);
        expect(fixture).toContain(`<span className="${badge}">`);
        expect(fixture).toMatch(/Skipper\s+<span className="font-semibold text-amber-200\/70"> · Beta<\/span>/);
    });
});
