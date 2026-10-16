import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn(), retire: vi.fn(), ingest: vi.fn() }));
vi.mock('../services/radar/radarStore', () => ({
    RadarStore: { openGateway: mocks.open, retire: mocks.retire, ingest: mocks.ingest },
}));
import { NmeaListenerService } from '../services/NmeaListenerService';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
const echo = frame('RATLL,1,5030.000,N,00115.000,W,Generated,120000,T,');
interface Harness {
    enabled: boolean;
    status: string;
    radarSession: unknown;
    setStatus(s: string): void;
    parseNmeaSentence(raw: string, at: number): void;
}
const h = NmeaListenerService as unknown as Harness;
afterEach(() => {
    h.enabled = false;
    h.setStatus('disconnected');
    vi.clearAllMocks();
});
describe('selected physical gateway radar lifecycle', () => {
    it('does not manufacture physical input from an inactive parser call', () => {
        h.enabled = false;
        h.setStatus('connected');
        h.parseNmeaSentence(echo, T);
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.ingest).not.toHaveBeenCalled();
    });
    it('uses one connected input token and passes original ingress clocks for target/navigation', () => {
        const token = { feedId: 'gateway:generated', source: 'gateway' };
        mocks.open.mockReturnValue(token);
        h.enabled = true;
        h.setStatus('disconnected');
        h.setStatus('connected');
        h.parseNmeaSentence(echo, T);
        const heading = frame('HEHDT,90,T');
        h.parseNmeaSentence(heading, T + 1000);
        h.setStatus('connected');
        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(mocks.ingest.mock.calls).toEqual([
            [token, echo, T],
            [token, heading, T + 1000],
        ]);
        h.parseNmeaSentence(echo.slice(0, -2) + 'zz', T + 2000);
        expect(mocks.ingest).toHaveBeenCalledTimes(2);
    });
    it('retires on transport loss and gives a replacement a distinct source token', () => {
        const first = { feedId: 'gateway:first' },
            second = { feedId: 'gateway:second' };
        mocks.open.mockReturnValueOnce(first).mockReturnValueOnce(second);
        h.enabled = true;
        h.setStatus('disconnected');
        h.setStatus('connected');
        h.parseNmeaSentence(echo, T);
        h.setStatus('error');
        h.parseNmeaSentence(echo, T + 1);
        expect(mocks.retire).toHaveBeenCalledWith(first);
        expect(mocks.ingest).toHaveBeenCalledTimes(1);
        h.setStatus('connected');
        h.parseNmeaSentence(echo, T + 2);
        expect(mocks.ingest).toHaveBeenLastCalledWith(second, echo, T + 2);
    });
});
