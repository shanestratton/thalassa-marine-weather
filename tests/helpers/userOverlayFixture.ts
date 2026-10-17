import { zipSync, strToU8 } from 'fflate';
export const wgs =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
export function shapeZip(prj = wgs) {
    const shp = new Uint8Array(128),
        v = new DataView(shp.buffer);
    v.setInt32(0, 9994);
    v.setInt32(24, 64);
    v.setInt32(28, 1000, true);
    v.setInt32(32, 1, true);
    v.setInt32(100, 1);
    v.setInt32(104, 10);
    v.setInt32(108, 1, true);
    v.setFloat64(112, 153, true);
    v.setFloat64(120, -27, true);
    const dbf = new Uint8Array(71),
        d = new DataView(dbf.buffer);
    dbf[0] = 3;
    d.setUint32(4, 1, true);
    d.setUint16(8, 65, true);
    d.setUint16(10, 6, true);
    dbf.set(strToU8('NAME'), 32);
    dbf[43] = 67;
    dbf[48] = 5;
    dbf[64] = 13;
    dbf[65] = 32;
    dbf.set(strToU8('Buoy '), 66);
    return zipSync({ 'sample.shp': shp, 'sample.dbf': dbf, 'sample.prj': strToU8(prj) });
}
