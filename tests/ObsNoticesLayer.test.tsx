import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { Notice } from '../services/NoticeToMarinersService';
import ObsNoticesLayer, { obsNoticePopup } from '../components/map/ObsNoticesLayer';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const h = vi.hoisted(() => ({
    notices: [] as Notice[],
    refresh: vi.fn(async () => []),
    changes: new Set<() => void>(),
    metered: false,
    local: async () => [],
    markers: [] as Array<{ element: HTMLElement; removed: boolean; lonlat: number[] }>,
}));
vi.mock('../services/NoticeToMarinersService', () => ({
    NoticeToMarinersService: {
        getCached: () => ({ notices: h.notices, fetchedAt: Date.now() }),
        getSourceHealth: () => [],
        refresh: h.refresh,
        onChange: (cb: () => void) => {
            h.changes.add(cb);
            return () => h.changes.delete(cb);
        },
    },
}));
vi.mock('../services/qldNotices', () => ({ cachedQldNotices: () => ({ notices: [], fetchedAt: null }) }));
vi.mock('../services/localNotices', () => ({ loadLocalNotices: () => h.local() }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => h.metered }));
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            entry;
            constructor({ element }: { element: HTMLElement }) {
                this.entry = { element, removed: false, lonlat: [] as number[] };
                h.markers.push(this.entry);
            }
            setLngLat(p: number[]) {
                this.entry.lonlat = p;
                return this;
            }
            addTo() {
                this.entry.element.setAttribute('role', 'img');
                document.body.append(this.entry.element);
                return this;
            }
            remove() {
                this.entry.removed = true;
                this.entry.element.remove();
                return this;
            }
        },
        Popup: class {
            node: HTMLElement | null = null;
            setLngLat() {
                return this;
            }
            setDOMContent(n: HTMLElement) {
                this.node = n;
                return this;
            }
            addTo() {
                if (this.node) document.body.append(this.node);
                return this;
            }
            getElement() {
                return this.node!;
            }
            remove() {
                this.node?.remove();
                return this;
            }
        },
    },
}));
const notice = (): Notice => ({
    id: '4-2026/1',
    msgYear: 2026,
    msgNumber: 1,
    navArea: '4',
    areaLabel: 'NAVAREA IV',
    subregion: '',
    issueDate: '160000Z OCT 2026',
    issueDateParsed: null,
    authority: 'Generated issuer',
    text: 'Invented warning',
    title: 'Synthetic notice',
    coordinates: [{ lat: 0, lon: 179.9 }],
    status: 'A',
});
function fixture() {
    const listeners = new Map<string, Set<() => void>>();
    const state = { zoom: 8, bounds: [179, -1, 181, 1] };
    const map = {
        getZoom: () => state.zoom,
        getContainer: () => ({ clientHeight: 667 }),
        getBounds: () => ({
            getWest: () => state.bounds[0],
            getSouth: () => state.bounds[1],
            getEast: () => state.bounds[2],
            getNorth: () => state.bounds[3],
        }),
        on: (key: string, cb: () => void) => {
            const set = listeners.get(key) ?? new Set();
            set.add(cb);
            listeners.set(key, set);
        },
        off: (key: string, cb: () => void) => listeners.get(key)?.delete(cb),
    } as unknown as mapboxgl.Map;
    return { map, state, emit: (key: string) => act(() => listeners.get(key)?.forEach((cb) => cb())) };
}
beforeEach(() => {
    h.notices = [notice()];
    h.refresh.mockClear();
    h.markers = [];
    h.changes.clear();
    h.metered = false;
    h.local = async () => [];
    setAuthIdentityScope('notice-owner');
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});
describe('foreground viewport-only notice lifecycle', () => {
    it('does no source refresh below zoom9, caps presentation to the actual viewport and retires on hide', async () => {
        const f = fixture(),
            view = render(<ObsNoticesLayer map={f.map} mapReady active enabled />);
        await act(async () => {});
        expect(screen.queryByRole('button', { name: 'Notice: Synthetic notice' })).toBeNull();
        expect(h.refresh).not.toHaveBeenCalled();
        f.state.zoom = 9;
        f.emit('zoomend');
        expect(screen.getByRole('button', { name: 'Notice: Synthetic notice' })).toBeVisible();
        expect(h.refresh).toHaveBeenCalledOnce();
        f.state.bounds = [0, -1, 1, 1];
        f.emit('moveend');
        expect(screen.queryByRole('button', { name: 'Notice: Synthetic notice' })).toBeNull();
        view.rerender(<ObsNoticesLayer map={f.map} mapReady active={false} enabled />);
        expect(h.markers.every((m) => m.removed)).toBe(true);
        expect(h.changes.size).toBe(0);
    });
    it('keeps cached markers aboard in Satellite Mode, retires popup/markers on account and ignores late local completion', async () => {
        const f = fixture();
        f.state.zoom = 9;
        h.metered = true;
        let done!: (value: never[]) => void;
        h.local = () =>
            new Promise<never[]>((resolve) => {
                done = resolve;
            });
        const view = render(<ObsNoticesLayer map={f.map} mapReady active enabled />);
        fireEvent.click(screen.getByRole('button', { name: 'Notice: Synthetic notice' }));
        expect(screen.getByText(/Coverage is incomplete/)).toBeVisible();
        expect(h.refresh).not.toHaveBeenCalled();
        const old = h.markers.slice();
        act(() => setAuthIdentityScope('new-notice-owner'));
        expect(old.every((m) => m.removed)).toBe(true);
        expect(screen.queryByText(/Coverage is incomplete/)).toBeNull();
        view.unmount();
        await act(async () => {
            done([]);
        });
        expect(screen.queryByRole('button', { name: 'Notice: Synthetic notice' })).toBeNull();
    });
    it('escapes issuer text and refuses unsafe links without inventing issue/receipt timestamps', () => {
        const n = notice();
        const node = obsNoticePopup(
            {
                id: n.id,
                lat: 0,
                lon: 0,
                title: '<img src=x onerror=alert(1)>',
                text: '<script>bad()</script>',
                issuer: '<b>Issuer</b>',
                issued: '',
                receivedAt: null,
                url: 'javascript:alert(1)',
                approximate: false,
            },
            Date.now(),
        );
        expect(node.querySelector('img,script,b,a')).toBeNull();
        expect(node.textContent).toContain('<img');
        expect(node.textContent).toContain('Issued: not supplied');
        expect(node.textContent).toContain('Source checked: unknown');
    });
});
