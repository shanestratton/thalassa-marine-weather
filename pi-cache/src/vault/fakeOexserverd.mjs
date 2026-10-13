#!/usr/bin/env node
/**
 * A FAKE oexserverd, for the chart vault's tests and the Mac dry run of Pi
 * update 3 (127-C-d). Fictional cells only: nothing here is, or reads, an
 * o-charts file.
 *
 * It speaks the real daemon's FIFO protocol (tools/senc-extractor/src/
 * oexserverd.ts, from hornang/oesenc-export): it makes the command FIFO
 * (VAULT_OEX_COMMAND_PIPE, mode 0600), reads 1,025-byte commands from it, and
 * answers CMD_READ_OESU (8) by writing SENC bytes into the caller's return FIFO
 * and closing it. CMD_EXIT (2) ends it. A FIFO is a kernel pipe: nothing it
 * carries is stored on a disk.
 *
 * Its ".oesu" files are not o-charts files. Each holds 'FAKEOESU1' and a
 * fictional cell's description (ids, edition, a box, one named buoy, one
 * sounding) XORed with the install key from the set's key XML, so a wrong key
 * decrypts to nothing, as a real daemon's would. The SENC it answers with is
 * built the way decryptBatch.test.mts's senc() helper builds one, plus two
 * features: a lateral buoy carrying OBJNAM and a sounding.
 *
 * Environment (the daemon only):
 *   VAULT_OEX_COMMAND_PIPE   the command FIFO (default /tmp/OCPN_PIPEX)
 *   FAKE_OEX_DONGLE_FILE     if set, the "dongle": while that file is missing
 *                            every answer is empty, as with the dongle out
 *   FAKE_OEX_DELAY_MS        wait this long before each answer
 *
 * Exported helpers (tests and the dry run): buildSenc, sealFixture,
 * openFixture, writeFixtureSet, writeFixtureCatalogue.
 */
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('FAKEOESU1');

/** S-57 object class and attribute codes the fixtures use (the standard's own numbers). */
export const FIXTURE_CODES = { BOYLAT: 17, SOUNDG: 129, OBJNAM: 116 };

function record(type, payload) {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(type, 0);
    head.writeUInt32LE(payload.length + 6, 2);
    return Buffer.concat([head, payload]);
}

const u16 = (value) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
};

const u32 = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
};

const cstr = (text) => Buffer.from(`${text}\0`, 'latin1');

/**
 * SENC bytes for one fictional cell: the header records, the extent, a lateral
 * buoy named `objnam` at the box's centre and one sounding of `depth` metres.
 */
export function buildSenc(spec) {
    const { s, w, n, e } = spec.extent;
    const extent = Buffer.alloc(64);
    // SW, NW, NE, SE corners, each (lat, lon).
    [s, w, n, w, n, e, s, e].forEach((value, i) => extent.writeDoubleLE(value, i * 8));
    const featureId = (classCode, rcid) => {
        const b = Buffer.alloc(5);
        b.writeUInt16LE(classCode, 0);
        b.writeUInt16LE(rcid, 2);
        b.writeUInt8(1, 4);
        return b;
    };
    const objnam = Buffer.concat([u16(FIXTURE_CODES.OBJNAM), Buffer.from([4]), cstr(spec.objnam)]);
    const point = Buffer.alloc(16);
    point.writeDoubleLE((s + n) / 2, 0);
    point.writeDoubleLE((w + e) / 2, 8);
    const sounding = Buffer.alloc(36 + 12);
    [s, n, w, e].forEach((value, i) => sounding.writeDoubleLE(value, i * 8));
    sounding.writeUInt32LE(1, 32);
    sounding.writeFloatLE(0, 36);
    sounding.writeFloatLE(0, 40);
    sounding.writeFloatLE(spec.depth, 44);
    return Buffer.concat([
        record(1, u16(201)),
        record(3, cstr(spec.issued ?? '20260920')),
        record(4, u16(spec.edition ?? 1)),
        record(6, u16(spec.update ?? 0)),
        ...(spec.scale ? [record(7, u32(spec.scale))] : []),
        record(100, extent),
        record(64, featureId(FIXTURE_CODES.BOYLAT, 1)),
        record(65, objnam),
        record(80, point),
        record(64, featureId(FIXTURE_CODES.SOUNDG, 2)),
        record(83, sounding),
    ]);
}

function xor(bytes, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length === 0) throw new Error('empty fixture key');
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
    return out;
}

/** The fixture ".oesu" bytes for a cell spec under an install key (hex). */
export function sealFixture(spec, keyHex) {
    return Buffer.concat([MAGIC, xor(Buffer.from(JSON.stringify(spec), 'utf8'), keyHex)]);
}

/** The cell spec inside fixture bytes, or null for a wrong key or not a fixture. */
export function openFixture(bytes, keyHex) {
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    try {
        const spec = JSON.parse(xor(bytes.subarray(MAGIC.length), keyHex).toString('utf8'));
        return spec && typeof spec === 'object' && spec.extent ? spec : null;
    } catch {
        return null;
    }
}

/**
 * Write one fictional delivered set into `dir`: a key XML naming each cell
 * (FileName, ID, RInstallKey) and one sealed ".oesu" per cell.
 *   keyFiles: how many key XMLs (default 1; 2 makes an ambiguous set)
 *   unkeyed:  cell file names written without a key entry
 */
export function writeFixtureSet(dir, { cells, keyHex = '0A1B2C3D', keyFiles = 1, unkeyed = [] }) {
    fs.mkdirSync(dir, { recursive: true });
    const charts = cells
        .map(
            (cell) =>
                `<Chart><FileName>${cell.file}</FileName>${cell.sourceCellId ? `<ID>${cell.sourceCellId}</ID>` : ''}<RInstallKey>${keyHex}</RInstallKey></Chart>`,
        )
        .join('');
    for (let i = 0; i < keyFiles; i++) {
        fs.writeFileSync(path.join(dir, `oeuSENC-ZZ-2026-1-${i}-sgl00ABCD.XML`), `<keyList>${charts}</keyList>`);
    }
    for (const cell of cells) fs.writeFileSync(path.join(dir, `${cell.file}.oesu`), sealFixture(cell, keyHex));
    for (const file of unkeyed) {
        fs.writeFileSync(path.join(dir, `${file}.oesu`), sealFixture({ file, extent: cells[0].extent }, keyHex));
    }
    return dir;
}

/** The two S-57 catalogue CSVs the parser needs, holding only the fixture's codes. */
export function writeFixtureCatalogue(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 's57objectclasses.csv'),
        'Code,ObjectClass,Acronym,Attribute_A,Attribute_B,Attribute_C,Class,Primitives\n' +
            `${FIXTURE_CODES.BOYLAT},"Buoy, lateral",BOYLAT,,,,G,Point\n` +
            `${FIXTURE_CODES.SOUNDG},Sounding,SOUNDG,,,,G,Point\n`,
    );
    fs.writeFileSync(
        path.join(dir, 's57attributes.csv'),
        `Code,Attribute,Acronym,Attributetype,Class\n${FIXTURE_CODES.OBJNAM},Object name,OBJNAM,S,F\n`,
    );
    return dir;
}

function readCString(buf, start, length) {
    const slice = buf.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The daemon: serve the command FIFO until CMD_EXIT. */
export function serve(pipe = process.env.VAULT_OEX_COMMAND_PIPE || '/tmp/OCPN_PIPEX') {
    try {
        fs.unlinkSync(pipe);
    } catch {
        /* absent */
    }
    execFileSync('mkfifo', ['-m', '600', pipe]);
    // Opened for reading AND writing, so it never sees end-of-file between
    // callers: each caller opens, writes one command, closes.
    const fd = fs.openSync(pipe, fs.constants.O_RDWR);
    const command = Buffer.alloc(1025);
    const delay = Number(process.env.FAKE_OEX_DELAY_MS || 0);
    try {
        for (;;) {
            let got = 0;
            while (got < command.length) got += fs.readSync(fd, command, got, command.length - got, null);
            const cmd = command[0];
            if (cmd === 2) break;
            const returnPipe = readCString(command, 1, 256);
            const chart = readCString(command, 257, 256);
            const key = readCString(command, 513, 512);
            let answer = Buffer.alloc(0);
            const dongle = process.env.FAKE_OEX_DONGLE_FILE;
            if (cmd === 8 && (!dongle || fs.existsSync(dongle))) {
                try {
                    const spec = openFixture(fs.readFileSync(chart), key);
                    if (spec) answer = buildSenc(spec);
                } catch {
                    answer = Buffer.alloc(0);
                }
            }
            if (delay > 0) sleep(delay);
            if (!returnPipe) continue;
            const out = fs.openSync(returnPipe, 'w');
            try {
                let sent = 0;
                while (sent < answer.length) sent += fs.writeSync(out, answer, sent, answer.length - sent);
            } finally {
                fs.closeSync(out);
            }
        }
    } finally {
        fs.closeSync(fd);
        try {
            fs.unlinkSync(pipe);
        } catch {
            /* gone */
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
