import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    finishOpenedChart,
    localChartUrlName,
    peekOpenedChart,
    stageOpenedChart,
    OPEN_CHART_EVENT,
} from '../services/charts/openedChartQueue';

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('crypto', webcrypto);
    setAuthIdentityScope(null);
    setAuthIdentityScope('a');
});
afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
});
describe('bounded local chart Open-in request', () => {
    it('stages only one original local URI and requires the consumer to obtain rights before any copy', () => {
        const opened = vi.fn();
        window.addEventListener(OPEN_CHART_EVENT, opened);
        stageOpenedChart('file:///Inbox/My%20chart.kap');
        const request = peekOpenedChart();
        expect(request?.name).toBe('My chart.kap');
        expect(request?.url).toBe('file:///Inbox/My%20chart.kap');
        expect(opened).toHaveBeenCalledOnce();
        expect(Object.keys(request!)).not.toContain('bytes');
        window.removeEventListener(OPEN_CHART_EVENT, opened);
    });
    it('never consumes a newer attachment with an older token', () => {
        stageOpenedChart('file:///Inbox/first.kap');
        const first = peekOpenedChart()!;
        stageOpenedChart('file:///Inbox/second.tif');
        finishOpenedChart(first.token);
        expect(peekOpenedChart()?.name).toBe('second.tif');
        finishOpenedChart(peekOpenedChart()!.token);
        expect(peekOpenedChart()).toBeNull();
    });
    it('retires pending and captured requests through account A/B/A', () => {
        const captured = getAuthIdentityScope();
        stageOpenedChart('file:///Inbox/first.kap');
        setAuthIdentityScope('b');
        setAuthIdentityScope('a');
        expect(peekOpenedChart()).toBeNull();
        expect(() => stageOpenedChart('file:///Inbox/first.kap', captured)).toThrow('stopped');
    });
    it('expires an unused URI after the fixed five-minute window', () => {
        vi.useFakeTimers();
        stageOpenedChart('file:///Inbox/first.kap');
        vi.advanceTimersByTime(300_000);
        expect(peekOpenedChart()).toBeNull();
    });
    it.each([
        'https://example.test/chart.kap',
        'file://foreign/Inbox/chart.kap',
        'file://user:pass@localhost/Inbox/chart.kap',
        'file:///Inbox/chart.kap?download=1',
        'file:///Inbox/chart.kap#file',
        'file:///Inbox/chart.bsb',
        'file:///Inbox/%2Fother.kap',
        'file:///Inbox/%2e%2e.kap',
        'file:///Inbox/chart.oesenc',
    ])('refuses a foreign URL, filename or BSB catalogue: %s', (url) => {
        expect(() => localChartUrlName(url)).toThrow();
        expect(peekOpenedChart()).toBeNull();
    });
});
