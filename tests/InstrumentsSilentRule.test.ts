/**
 * The aboard GPS/instruments-silent alarm (129-08): what was Calypso's
 * 'nmea-backbone-dead' rule, now a local alarm that needs neither Calypso nor
 * the internet. "No GPS or instruments from the boat for N minutes".
 *
 *  - It needs a reading that came from the boat herself (the gateway socket,
 *    or the Pi over the boat's network): a cloud row that stops is the
 *    internet, not her instruments.
 *  - It fires only with the phone aboard, and only when silence matters: under
 *    way, an anchor watch on, or a voyage track recording. A berth with the
 *    instruments switched off says nothing.
 *  - Once sounding it keeps going (her own GPS is what tells "aboard", and it
 *    is the thing that went quiet) until the data is back, she is acknowledged
 *    or the phone is shown to be ashore.
 */
import { describe, expect, it } from 'vitest';
import {
    INSTRUMENTS_SILENT_AFTER_MS,
    INSTRUMENTS_SILENT_START,
    acknowledgeInstrumentsSilent,
    instrumentsSilentLines,
    instrumentsSilentLockScreen,
    nextInstrumentsSilent,
    type InstrumentsSilentInput,
} from '../services/underway/instrumentsSilentRule';

const T = Date.UTC(2026, 9, 14, 11, 0, 0);
const MIN = 60_000;
const base = (o: Partial<InstrumentsSilentInput> = {}): InstrumentsSilentInput => ({
    nowMs: T + 2 * MIN,
    where: 'aboard',
    live: false,
    lastLive: { at: T, lane: 'pi-direct' },
    armed: true,
    ...o,
});

describe('when it sounds', () => {
    it('after 2 minutes with nothing from her GPS or instruments, aboard and under way', () => {
        expect(INSTRUMENTS_SILENT_AFTER_MS).toBe(2 * MIN);
        expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ nowMs: T + 2 * MIN - 1 })).status).toBe('quiet');
        expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base())).toEqual({ status: 'sounding', since: T });
    });

    it('from the gateway socket as from the Pi over the boat’s network', () => {
        expect(
            nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ lastLive: { at: T, lane: 'socket' } })).status,
        ).toBe('sounding');
    });

    it('never while the phone is not aboard', () => {
        for (const where of ['ashore', 'unknown'] as const) {
            expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ where })).status).toBe('quiet');
        }
    });

    it('never for a cloud row or a phone’s share that stopped: that is the internet, not her instruments', () => {
        for (const lane of ['cloud', 'shared'] as const) {
            expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ lastLive: { at: T, lane } })).status).toBe(
                'quiet',
            );
        }
    });

    it('never with no reading this session, nor at a berth with nothing to watch', () => {
        expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ lastLive: null })).status).toBe('quiet');
        expect(nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base({ armed: false })).status).toBe('quiet');
    });
});

describe('once it sounds', () => {
    const sounding = nextInstrumentsSilent(INSTRUMENTS_SILENT_START, base());

    it('keeps sounding when her silent GPS can no longer say the phone is aboard', () => {
        expect(nextInstrumentsSilent(sounding, base({ nowMs: T + 25 * MIN, where: 'unknown' }))).toEqual(sounding);
    });

    it('stands down when the data is back, or the phone is shown to be ashore', () => {
        expect(nextInstrumentsSilent(sounding, base({ live: true }))).toEqual(INSTRUMENTS_SILENT_START);
        expect(nextInstrumentsSilent(sounding, base({ where: 'ashore' }))).toEqual(INSTRUMENTS_SILENT_START);
    });

    it('acknowledged: silent until the data is back, then it re-arms', () => {
        const quiet = acknowledgeInstrumentsSilent(sounding);
        expect(quiet.status).toBe('acknowledged');
        expect(nextInstrumentsSilent(quiet, base({ nowMs: T + 30 * MIN }))).toEqual(quiet);
        const back = nextInstrumentsSilent(quiet, base({ live: true }));
        expect(back).toEqual(INSTRUMENTS_SILENT_START);
        expect(
            nextInstrumentsSilent(
                back,
                base({ nowMs: T + 40 * MIN, lastLive: { at: T + 38 * MIN, lane: 'pi-direct' } }),
            ).status,
        ).toBe('sounding');
    });
});

describe('what it says', () => {
    it('“No GPS or instruments from the boat for N minutes”, counted from the last reading', () => {
        const sounding = { status: 'sounding' as const, since: T };
        expect(instrumentsSilentLines(sounding, T + 2 * MIN).value).toBe(
            'No GPS or instruments from the boat for 2 minutes',
        );
        expect(instrumentsSilentLines(sounding, T + 61_000).value).toBe(
            'No GPS or instruments from the boat for 1 minute',
        );
        expect(instrumentsSilentLines(sounding, T + 95 * MIN).value).toBe(
            'No GPS or instruments from the boat for 95 minutes',
        );
        expect(instrumentsSilentLockScreen(sounding, T + 3 * MIN)).toEqual({
            title: 'No GPS or instruments from the boat for 3 minutes',
            body: 'Check her instruments’ power and the gateway.',
        });
    });

    it('claims nothing it cannot know', () => {
        const lines = instrumentsSilentLines({ status: 'sounding', since: T }, T + 4 * MIN);
        const all = `${lines.title} ${lines.value} ${lines.detail}`;
        expect(all).not.toMatch(/sink|power cut|lost power|Calypso|internet/i);
    });
});
