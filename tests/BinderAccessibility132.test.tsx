/**
 * Binder accessibility and house patterns (132-B20): the parts that are not
 * one binder page's own.
 *
 * - PageHeader's title is never cut: where the parent's name beside the
 *   chevron leaves no room for it ('MAINTENA' at 320 pt), the name gives way,
 *   and comes back when the room does. The chevron keeps its spoken name. A
 *   ⋮ arriving after the header was drawn counts; a name that would not help
 *   stays. An Equipment item's name wraps whole, and past two lines the
 *   parent's name gives it room.
 * - The Boat Binder screen is on PageHeader; its short-screen tightening
 *   follows it there.
 * - A disabled hub row is a disabled button (the observer's Polars row).
 * - The Equipment page is on PageHeader, with Edit in its action slot; the
 *   56 px floating Edit is gone.
 * - Small red, label and stat words reach 4.5:1: the hub's past-due status,
 *   the Equipment warranty dates, Maintenance's hours label and the GPX
 *   import's stat labels.
 * - New task's Type is a named group.
 * - The Documents and Galley layout fixtures draw App.tsx's real header,
 *   SKIPPER · BETA badge and all, as the binder fixture does (132-B19).
 *
 * Fictional gear only: a 'Watermaker' by 'Make'.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem } from '../types';
import { contrast } from './helpers/colourScience';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { PageHeader } from '../components/ui/PageHeader';
import { OfficeRow } from '../components/vesselHub/listRows';
import { EquipmentDetail } from '../components/vessel/equipment/EquipmentDetail';
import { TaskFormModal } from '../components/vessel/maintenance/TaskFormModal';
import { useMaintenanceForm } from '../hooks/useMaintenanceForm';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';

// The sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const read = (path: string) => readFileSync(path, 'utf8');

describe("PageHeader: the title before the parent's name (132-B20)", () => {
    /**
     * What jsdom cannot lay out, set by each test: the width the title needs
     * and the width it has beside the parent's name, the width that name gives
     * back when it goes, the header's width, and the title's height beside the
     * name and without it, in 25 px lines.
     */
    const layout = { titleNeeds: 0, titleHas: 0, nameGivesBack: 90, header: 320, tall: 25, tallAlone: 25 };
    const nameShown = () => !!document.querySelector('[data-page-back] button span');
    const resized: (() => void)[] = [];
    type Measured = 'scrollWidth' | 'clientWidth' | 'clientHeight';
    const own = (name: Measured) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    const saved = {
        scrollWidth: own('scrollWidth'),
        clientWidth: own('clientWidth'),
        clientHeight: own('clientHeight'),
    };
    const realStyle = window.getComputedStyle.bind(window);
    let styleSpy: { mockRestore: () => void } | undefined;

    function measure() {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get(this: HTMLElement) {
                return this.tagName === 'H1' ? layout.titleNeeds : 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.tagName === 'H1') return layout.titleHas + (nameShown() ? 0 : layout.nameGivesBack);
                return this.hasAttribute('data-page-header') ? layout.header : 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.tagName !== 'H1') return 0;
                return nameShown() ? layout.tall : layout.tallAlone;
            },
        });
        // A wrapping title counts its lines by the line height the stylesheet gives it.
        styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
            const style = realStyle(el, pseudo);
            if (el.tagName !== 'H1') return style;
            return new Proxy(style, {
                get: (target, prop) => {
                    if (prop === 'lineHeight') return '25px';
                    const value = Reflect.get(target, prop, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        });
        // tests/setup.ts's stand-in never calls back; this one hands the callback over.
        window.ResizeObserver = class {
            constructor(private readonly callback: () => void) {}
            observe() {
                resized.push(this.callback);
            }
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
    }
    const setupObserver = window.ResizeObserver;

    afterEach(() => {
        for (const name of ['scrollWidth', 'clientWidth', 'clientHeight'] as const) {
            if (saved[name]) Object.defineProperty(HTMLElement.prototype, name, saved[name]!);
            else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        }
        styleSpy?.mockRestore();
        styleSpy = undefined;
        window.ResizeObserver = setupObserver;
        resized.length = 0;
        Object.assign(layout, { nameGivesBack: 90, tall: 25, tallAlone: 25 });
    });

    const header = () => (
        <PageHeader
            title="Maintenance"
            onBack={vi.fn()}
            breadcrumbs={['Boat Binder', 'Maintenance']}
            action={<button type="button">Page actions</button>}
        />
    );
    const back = () => screen.getByRole('button', { name: 'Back to Boat Binder' });

    it("keeps '‹ BOAT BINDER' beside the chevron while the title fits", () => {
        measure();
        Object.assign(layout, { titleNeeds: 120, titleHas: 160, header: 390 });
        render(header());
        expect(back()).toHaveTextContent('Boat Binder');
    });

    it('drops the name when the title would be cut, and the chevron still says where it goes', () => {
        measure();
        Object.assign(layout, { titleNeeds: 123, titleHas: 100, header: 288 });
        render(header());
        expect(back()).not.toHaveTextContent('Boat Binder');
        expect(screen.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeInTheDocument();
    });

    it('tries the name again at a new width, and keeps it once there is room', () => {
        measure();
        Object.assign(layout, { titleNeeds: 123, titleHas: 100, header: 288 });
        render(header());
        expect(back()).not.toHaveTextContent('Boat Binder');
        // Turned to landscape: room for both.
        Object.assign(layout, { titleNeeds: 123, titleHas: 400, header: 640 });
        act(() => resized.forEach((callback) => callback()));
        expect(back()).toHaveTextContent('Boat Binder');
    });

    it('tries the name again for a new title, as an Equipment page does for the next item', () => {
        measure();
        Object.assign(layout, { titleNeeds: 123, titleHas: 100, header: 288 });
        const page = (title: string) => (
            <PageHeader title={title} onBack={vi.fn()} breadcrumbs={['Boat Binder', title]} />
        );
        const { rerender } = render(page('Maintenance'));
        expect(back()).not.toHaveTextContent('Boat Binder');
        Object.assign(layout, { titleNeeds: 60, titleHas: 100 });
        rerender(page('Galley'));
        expect(back()).toHaveTextContent('Boat Binder');
    });

    it('a header without a parent beside the chevron is left alone', () => {
        measure();
        Object.assign(layout, { titleNeeds: 200, titleHas: 100, header: 288 });
        render(<PageHeader title="Boat Binder" onBack={vi.fn()} backLabel="Back to Vessel" />);
        expect(screen.getByRole('button', { name: 'Back to Vessel' })).toHaveTextContent('');
        expect(resized).toHaveLength(0);
    });

    // An empty Checklists page has no ⋮; its second item brings one, after the
    // header was measured. 'CHECKLISTS' was cut by 18 px at 320 pt, '‹ BOAT
    // BINDER' still beside it, on a new skipper's first session.
    const checklists = (withMenu: boolean) => (
        <PageHeader
            title="Checklists"
            onBack={vi.fn()}
            breadcrumbs={['Boat Binder', 'Checklists']}
            action={withMenu ? <button type="button">Page actions</button> : undefined}
        />
    );

    it('gives way to a ⋮ that arrives after the header was measured, and tries again when it goes', () => {
        measure();
        Object.assign(layout, { titleNeeds: 120, titleHas: 160, header: 288 });
        const { rerender } = render(checklists(false));
        expect(back()).toHaveTextContent('Boat Binder');
        // The ⋮ takes 56 px of the title's column.
        Object.assign(layout, { titleHas: 104 });
        rerender(checklists(true));
        expect(back()).not.toHaveTextContent('Boat Binder');
        expect(screen.getByRole('heading', { level: 1, name: 'Checklists' })).toBeInTheDocument();
        // The last item deleted: the ⋮ goes, and the name fits again.
        Object.assign(layout, { titleHas: 160 });
        rerender(checklists(false));
        expect(back()).toHaveTextContent('Boat Binder');
    });

    it("measures again when the title's column narrows with nothing else changed", () => {
        measure();
        Object.assign(layout, { titleNeeds: 120, titleHas: 160, header: 288 });
        render(checklists(true));
        expect(back()).toHaveTextContent('Boat Binder');
        // The action grew after it was drawn: the header is as wide, the title not.
        Object.assign(layout, { titleHas: 104 });
        act(() => resized.forEach((callback) => callback()));
        expect(back()).not.toHaveTextContent('Boat Binder');
    });

    it('keeps the name where giving way would leave the title cut anyway', () => {
        measure();
        // A word wider than the whole column, the name gone or not.
        Object.assign(layout, { titleNeeds: 300, titleHas: 100, header: 288 });
        render(header());
        expect(back()).toHaveTextContent('Boat Binder');
        expect(screen.getByRole('heading', { level: 1 }).className).toContain('line-clamp-2');
    });

    describe('a title that wraps whole, as an Equipment item names its page', () => {
        const item = (name: string) => (
            <PageHeader
                title={name}
                wrapTitle
                onBack={vi.fn()}
                breadcrumbs={['Equipment', name]}
                backLabel="Back to equipment list"
                action={<button type="button">Edit equipment</button>}
            />
        );
        const toList = () => screen.getByRole('button', { name: 'Back to equipment list' });
        const LONG = 'Autopilot drive, below-deck hydraulic ram';

        it('is never clamped to two lines', () => {
            measure();
            Object.assign(layout, { titleNeeds: 100, titleHas: 145, header: 343 });
            render(item(LONG));
            const h1 = screen.getByRole('heading', { level: 1, name: LONG });
            expect(h1.className).not.toContain('line-clamp');
            expect(h1.className).toContain('overflow-hidden');
            expect(h1.className).toContain('[overflow-wrap:normal]');
        });

        it("keeps '‹ EQUIPMENT' beside a name on two lines", () => {
            measure();
            Object.assign(layout, { titleNeeds: 100, titleHas: 145, header: 343, tall: 50, tallAlone: 50 });
            render(item('Main engine'));
            expect(toList()).toHaveTextContent('Equipment');
        });

        it('past two lines, the name gives way where that makes the title shorter', () => {
            measure();
            Object.assign(layout, { titleNeeds: 100, titleHas: 145, header: 343, tall: 100, tallAlone: 75 });
            render(item(LONG));
            expect(toList()).not.toHaveTextContent('Equipment');
            expect(screen.getByRole('heading', { level: 1, name: LONG })).toBeInTheDocument();
        });

        it('and stays where the title would be no shorter without it', () => {
            measure();
            Object.assign(layout, { titleNeeds: 100, titleHas: 145, header: 343, tall: 100, tallAlone: 100 });
            render(item(LONG));
            expect(toList()).toHaveTextContent('Equipment');
        });

        it('breaks a word too wide for any column rather than cut it, the name beside it', () => {
            measure();
            Object.assign(layout, { titleNeeds: 400, titleHas: 100, header: 288 });
            render(item('Hydrogeneratorcontroller'));
            expect(toList()).toHaveTextContent('Equipment');
            expect(screen.getByRole('heading', { level: 1 }).className).toContain('[overflow-wrap:anywhere]');
        });
    });
});

describe('the Boat Binder screen is on PageHeader (132-B20)', () => {
    const hub = read('components/VesselHub.tsx');
    const binder = hub.slice(hub.indexOf('if (binderOpen) {'), hub.indexOf('<BinderSubLabel>Inventory'));

    it('uses PageHeader for its chevron and h1, not a hand-built copy', () => {
        expect(binder).toMatch(/<div className="vessel-binder-header shrink-0">\s*<PageHeader\s+title="Boat Binder"/);
        expect(binder).toContain('backLabel="Back to Vessel"');
        expect(binder).not.toContain('<h1');
        expect(binder).not.toContain('<BackButton');
    });

    it('keeps its short-screen tightening, now on the PageHeader inside it', () => {
        const css = read('styles/menu-page-fit.css');
        expect(css.match(/\.vessel-binder-header > \[data-page-header\] \{/g)).toHaveLength(2);
        expect(css).not.toMatch(/\.vessel-binder-header \{/);
    });
});

describe("a disabled hub row is a disabled button: the observer's Polars (132-B20)", () => {
    it('is disabled, never fires, and its status still says why', () => {
        const onClick = vi.fn();
        render(
            <OfficeRow
                icon={<span />}
                label="Polars"
                status="Vessel required"
                statusColor="#6b7280"
                onClick={onClick}
                disabled
            />,
        );
        const row = screen.getByRole('button', { name: 'Polars' });
        expect(row).toBeDisabled();
        expect(row).toHaveAccessibleDescription('Vessel required');
        fireEvent.click(row);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('an enabled row is a plain button that works', () => {
        const onClick = vi.fn();
        render(
            <OfficeRow icon={<span />} label="Galley" status="Meal planning" statusColor="#94a3b8" onClick={onClick} />,
        );
        const row = screen.getByRole('button', { name: 'Galley' });
        expect(row).toBeEnabled();
        expect(row).toHaveAttribute('type', 'button');
        fireEvent.click(row);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('the Binder passes the observer through to it', () => {
        const hub = read('components/VesselHub.tsx');
        const polars = hub.slice(hub.indexOf('label="Polars"'), hub.indexOf('label="Import GPX"'));
        expect(polars).toContain('disabled={isObserver}');
    });
});

describe('the Equipment page is on PageHeader, and its Edit FAB is gone (132-B20)', () => {
    const watermaker: EquipmentItem = {
        id: 'e-wm',
        user_id: 'skipper-1',
        equipment_name: 'Watermaker',
        category: 'Plumbing',
        make: 'Make',
        model: 'Model',
        serial_number: 'SN-FICTIONAL',
        installation_date: null,
        warranty_expiry: '2020-01-01',
        manual_uri: null,
        notes: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
    } as EquipmentItem;

    it('names the page by the item as its h1, under the Equipment crumb, with Edit in the header', () => {
        const onBack = vi.fn();
        const onEdit = vi.fn();
        const { container } = render(
            <EquipmentDetail item={watermaker} onBack={onBack} onEdit={onEdit} onDelete={vi.fn()} />,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Watermaker' })).toBeInTheDocument();
        const header = container.querySelector<HTMLElement>('[data-page-header]')!;
        const back = within(header).getByRole('button', { name: 'Back to equipment list' });
        expect(back).toHaveTextContent('Equipment');
        fireEvent.click(back);
        expect(onBack).toHaveBeenCalledTimes(1);

        const edit = within(header).getByRole('button', { name: 'Edit equipment' });
        expect(edit.className).toContain('min-h-[44px]');
        expect(edit.className).toContain('min-w-[44px]');
        fireEvent.click(edit);
        expect(onEdit).toHaveBeenCalledTimes(1);
        // One Edit, and nothing pinned over the page's last rows.
        expect(screen.getAllByRole('button', { name: 'Edit equipment' })).toHaveLength(1);
        expect(container.querySelector('.fixed')).toBeNull();
    });

    it("shows a long name whole: the page's h1 wraps, never clamped to two lines", () => {
        const name = 'Watermaker, high-pressure pump and pre-filters';
        render(<EquipmentDetail item={{ ...watermaker, equipment_name: name }} onBack={vi.fn()} onEdit={vi.fn()} />);
        const h1 = screen.getByRole('heading', { level: 1, name });
        expect(h1).toHaveTextContent(name);
        expect(h1.className).not.toContain('line-clamp');
    });

    it("writes a lapsed warranty's date in full-strength red", () => {
        render(<EquipmentDetail item={watermaker} onBack={vi.fn()} onEdit={vi.fn()} />);
        const date = screen.getByText(/^Expired \w/);
        expect(date.className).toContain('text-red-400');
        expect(date.className).not.toMatch(/text-red-400\/\d+/);
    });
});

describe("New task's Type is a named group (132-B20)", () => {
    function Host() {
        const f = useMaintenanceForm();
        return (
            <TaskFormModal
                mode="add"
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

    it('holds Maintenance and Repair under its name', () => {
        render(<Host />);
        const type = screen.getByRole('group', { name: 'Type' });
        expect(
            within(type)
                .getAllByRole('button')
                .map((button) => button.textContent?.trim()),
        ).toEqual(['Maintenance', 'Repair']);
    });
});

/*
 * The small words, measured. Tailwind v4's sRGB values: slate-950 #020618
 * under the pages, the hub's glass rgba(20, 25, 35, 0.6) over it.
 */
describe('small red, label and stat words reach 4.5:1 (132-B20)', () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const over = (fg: string, alpha: number, bg: string) =>
        '#' +
        hex(fg)
            .map((c, i) => Math.round(c * alpha + hex(bg)[i] * (1 - alpha)))
            .map((c) => c.toString(16).padStart(2, '0'))
            .join('');
    const PAGE = '#020618';
    const GLASS = over('#141923', 0.6, PAGE);
    const PRESSED = over('#ffffff', 0.03, GLASS);

    it("the hub's past-due status words: red-400, with room to spare even on a pressed row", () => {
        const hub = read('components/VesselHub.tsx');
        expect(hub).toContain("const HUB_DANGER_TEXT = '#f87171';");
        expect(hub).not.toMatch(/statusColor=\{[^}]*'#ef4444'/);
        expect(contrast('#f87171', PRESSED)).toBeGreaterThanOrEqual(6);
        // What it replaced, for the record: over the floor, not by much.
        expect(contrast('#ef4444', PRESSED)).toBeLessThan(4.8);
    });

    it("the Equipment page's warranty dates: full strength on their tinted cards", () => {
        const redCard = over('#fb2c36', 0.1, PAGE);
        expect(contrast(over('#ff6467', 0.7, redCard), redCard)).toBeLessThan(4.5);
        expect(contrast('#ff6467', redCard)).toBeGreaterThanOrEqual(4.5);
        const detail = read('components/vessel/equipment/EquipmentDetail.tsx');
        expect(detail).not.toMatch(/text-(red|emerald)-400\/70/);
    });

    it("Maintenance's engine-hours label: full-strength sky on the sky card", () => {
        const skyCard = over('#00a6f4', 0.15, PAGE);
        expect(contrast(over('#00bcff', 0.7, skyCard), skyCard)).toBeLessThan(4.5);
        expect(contrast('#00bcff', skyCard)).toBeGreaterThanOrEqual(4.5);
        const page = read('components/vessel/MaintenanceHub.tsx');
        expect(page).toContain(
            "const HOURS_LABEL = 'block text-label text-sky-400 font-bold uppercase tracking-widest';",
        );
        expect(page).not.toContain('text-sky-400/70');
    });

    it("the GPX import's stat labels: the card's full colour, not 60% of it", () => {
        for (const [c500, c400] of [
            ['#00a6f4', '#00bcff'],
            ['#ad46ff', '#c27aff'],
            ['#00bc7d', '#00d492'],
            ['#fe9a00', '#ffb900'],
        ]) {
            const card = over(c500, 0.1, PAGE);
            expect(contrast(c400, card)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(over('#c27aff', 0.6, over('#ad46ff', 0.1, PAGE)), over('#ad46ff', 0.1, PAGE))).toBeLessThan(
            4.5,
        );
        const gpx = read('components/vessel/GpxImportPage.tsx');
        const statCard = gpx.slice(gpx.indexOf('const StatCard'));
        expect(statCard).toContain('<p className="text-[11px] font-bold uppercase tracking-widest">{label}</p>');
        expect(statCard).not.toContain('opacity-60');
    });
});

describe('the Documents and Galley fixtures draw the real header (132-B20)', () => {
    const app = read('App.tsx');
    const badge = app.match(/<span className="(thalassa-beta-badge [^"]+)">/)![1];
    const HEADER = [
        'thalassa-header-logo',
        'w-[64px] h-[64px] max-[389px]:w-12 max-[389px]:h-12',
        'flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5',
        'shrink-0 whitespace-nowrap text-xl font-bold tracking-wider uppercase',
        'text-[11px] font-bold uppercase leading-none tracking-wider',
        'flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200',
        'flex shrink-0 items-center gap-2 pointer-events-auto',
    ];

    it.each(['e2e/fixtures/documents.tsx', 'e2e/fixtures/galley-layout.tsx'])(
        '%s carries App.tsx header classes and the SKIPPER · BETA badge',
        (path) => {
            const fixture = read(path);
            for (const classes of HEADER) {
                expect(app, classes).toContain(classes);
                expect(fixture, classes).toContain(classes);
            }
            expect(PUBLIC_BETA_ACCESS.enabled).toBe(true);
            expect(fixture).toContain(`<span className="${badge}">`);
            expect(fixture).toMatch(/Skipper\s+<span className="font-semibold text-amber-200\/70"> · Beta<\/span>/);
        },
    );
});
