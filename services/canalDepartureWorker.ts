import { buildCanalDepartureGeometry } from './canalDepartureGeometry';

const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent<Parameters<typeof buildCanalDepartureGeometry>>) => void) | null;
    postMessage(value: unknown, transfer?: Transferable[]): void;
};
ctx.onmessage = ({ data }) => {
    try {
        const result = buildCanalDepartureGeometry(...data);
        ctx.postMessage({ result }, [result.grid.water.buffer]);
    } catch (e) {
        ctx.postMessage({ error: e instanceof Error ? e.message : 'Canal routing failed.' });
    }
};
