import { decodeGribImportRequest, gribTransferables, type GribImportRequest } from './gribImportProtocol';

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<GribImportRequest>) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
    close: () => void;
};
scope.onmessage = ({ data }) => {
    const deadline = Date.now() + 10_000;
    const reply = decodeGribImportRequest(data, () => Date.now() < deadline);
    scope.postMessage(reply, reply.type === 'decoded' ? gribTransferables(reply.grid) : []);
    scope.close();
};
scope.postMessage({ type: 'ready' });
