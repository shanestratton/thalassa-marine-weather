import { expect, it } from 'vitest';
import { encodeLocalChartBase64, decodeLocalChartBase64 } from '../services/charts/localChartWebEncoding';
import { readLocalChartManifest } from '../services/charts/localChartLibraryContract';
it.each(['raw', 'gzip'])('rejects unrecognised retained encoding marker %s', (webEncoding) => {
    const ownerNamespace = 'a'.repeat(32);
    expect(() =>
        readLocalChartManifest(
            JSON.stringify({
                schema: 1,
                ownerNamespace,
                charts: [
                    {
                        id: '00000000-0000-4000-8000-000000000001',
                        name: 'own.kap',
                        kind: 'kap',
                        bytes: 512,
                        rights: 'own',
                        importedAt: Date.UTC(2026, 9, 17),
                        sha256: 'a'.repeat(64),
                        webEncoding,
                    },
                ],
            }),
            ownerNamespace,
        ),
    ).toThrow();
});
it.each([512, 513, 514, 100000])('round-trips %i bytes through bounded binary-string chunks', (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, n) => n % 256),
        check = () => {};
    expect(decodeLocalChartBase64(encodeLocalChartBase64(bytes, check), size, check)).toEqual(bytes);
});
it.each(['AAAAAAAAAAA', 'AAAA AAAAAA=', 'AAAA=AAAAAA=', 'AAAAAAAAAAA==='])(
    'refuses malformed or noncanonical stored text %s',
    (value) => {
        expect(() => decodeLocalChartBase64(value, 8, () => {})).toThrow();
    },
);
it('checks source retirement inside both conversion directions', () => {
    const check = () => {
        throw new Error('Retired');
    };
    expect(() => encodeLocalChartBase64(new Uint8Array(512), check)).toThrow('Retired');
    expect(() => decodeLocalChartBase64('AAAAAAAAAAA=', 8, check)).toThrow('Retired');
});
