import { decodeGrib1File, gribEdition } from './decodeGrib1Wind';
import { decodeGrib2Import } from './decodeGrib2Import';
import { GribImportError, type ImportedGribFile, type GribImportCode } from './gribImportTypes';

export interface GribImportRequest {
    id: number;
    buffer: ArrayBuffer;
}
export type GribImportReply =
    | { type: 'ready' }
    | { type: 'decoded'; id: number; grid: ImportedGribFile }
    | { type: 'error'; id: number; code: GribImportCode; message: string };

/** Attachment-only readers validate framing/identity/bounds before allocation. */
export function decodeGribImportRequest(request: GribImportRequest, current: () => boolean): GribImportReply {
    const id = Number.isSafeInteger(request?.id) && request.id > 0 ? request.id : 0;
    try {
        if (!id || !(request.buffer instanceof ArrayBuffer))
            throw new GribImportError('MALFORMED', 'Invalid GRIB import request.');
        return {
            type: 'decoded',
            id,
            grid:
                gribEdition(request.buffer) === 1
                    ? decodeGrib1File(request.buffer, current)
                    : decodeGrib2Import(request.buffer, current),
        };
    } catch (error) {
        return {
            type: 'error',
            id,
            code: error instanceof GribImportError ? error.code : 'MALFORMED',
            message: error instanceof GribImportError ? error.message : 'The GRIB import could not be decoded.',
        };
    }
}
export function gribTransferables(grid: ImportedGribFile): ArrayBuffer[] {
    return [
        ...(grid.wind ? [...grid.wind.u, ...grid.wind.v, ...grid.wind.speed] : []),
        ...(grid.pressure?.frames ?? []),
    ].map((values) => values.buffer as ArrayBuffer);
}
