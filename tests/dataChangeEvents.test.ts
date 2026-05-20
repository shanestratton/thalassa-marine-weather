/**
 * Tests for dataChangeEvents — the window-event backbone that keeps
 * summary surfaces (overdue / expiring / warranty badges) fresh. If a
 * mutation dispatches an event and the surface listens for it, the
 * count refetches. These tests exercise that dispatch→listen seam and
 * lock the event names so a rename can't silently break propagation
 * (producer and consumer both import from here, so a drift would be
 * caught — but the string values are the contract with any code that
 * still hardcodes them).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_EVENTS, dispatchDataChange } from '../utils/dataChangeEvents';

describe('dataChangeEvents', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exposes stable event-name strings (the cross-module contract)', () => {
        expect(DATA_EVENTS.MAINTENANCE).toBe('thalassa:maintenance-changed');
        expect(DATA_EVENTS.EQUIPMENT).toBe('thalassa:equipment-changed');
        expect(DATA_EVENTS.DOCUMENTS).toBe('thalassa:documents-changed');
        expect(DATA_EVENTS.ROUTES_AND_TRACKS).toBe('thalassa:routes-and-tracks-changed');
        expect(DATA_EVENTS.SHIP_LOG_ENTRIES).toBe('thalassa:ship-log-entries-changed');
    });

    it('dispatchDataChange delivers the event to a window listener (mutation → refetch trigger)', () => {
        const handler = vi.fn();
        window.addEventListener(DATA_EVENTS.MAINTENANCE, handler);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        expect(handler).toHaveBeenCalledTimes(1);
        window.removeEventListener(DATA_EVENTS.MAINTENANCE, handler);
    });

    it('only the matching listener fires (no cross-talk between data categories)', () => {
        const maint = vi.fn();
        const docs = vi.fn();
        window.addEventListener(DATA_EVENTS.MAINTENANCE, maint);
        window.addEventListener(DATA_EVENTS.DOCUMENTS, docs);

        dispatchDataChange(DATA_EVENTS.DOCUMENTS);

        expect(docs).toHaveBeenCalledTimes(1);
        expect(maint).not.toHaveBeenCalled();

        window.removeEventListener(DATA_EVENTS.MAINTENANCE, maint);
        window.removeEventListener(DATA_EVENTS.DOCUMENTS, docs);
    });

    it('every registered listener for an event fires (multiple summary surfaces stay in sync)', () => {
        const a = vi.fn();
        const b = vi.fn();
        window.addEventListener(DATA_EVENTS.EQUIPMENT, a);
        window.addEventListener(DATA_EVENTS.EQUIPMENT, b);
        dispatchDataChange(DATA_EVENTS.EQUIPMENT);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        window.removeEventListener(DATA_EVENTS.EQUIPMENT, a);
        window.removeEventListener(DATA_EVENTS.EQUIPMENT, b);
    });
});
