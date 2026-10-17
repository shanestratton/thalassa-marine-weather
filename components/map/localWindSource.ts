import type { WindState } from '../../stores/WindStore';

/** A local file must never inherit the online model picker or its attribution. */
export function localWindSource(state: Pick<WindState, 'isGlobalMode' | 'localGribPath'> | undefined): string | null {
    if (!state || state.isGlobalMode !== false) return null;
    return state.localGribPath?.startsWith('grib-import/') ? 'Imported GRIB' : 'Downloaded wind';
}
