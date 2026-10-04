// @vitest-environment node
/**
 * Extracted native path helpers + disposable local SQLite fixture only.
 * One bounded Swift compilation runs sequentially before these assertions.
 * No app container, Keychain, Auth, provider, network or physical device access.
 * Passing does NOT establish crypto/session correctness or on-device recovery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../experiments/scuttlebutt-e2ee/', import.meta.url));
const DIRECTORY_SOURCE = readFileSync(join(SOURCE_ROOT, 'VodozemacAccountDirectory.swift'), 'utf8');
const STORE_SOURCE = readFileSync(join(SOURCE_ROOT, 'VodozemacSealedStore.swift'), 'utf8');
const TEMP_PREFIX = 'thalassa-research-native-path-fixture-';
let temporaryRoot: string | undefined;
let observations: Record<string, unknown> | undefined;

function swiftDeclaration(source: string, signature: RegExp): { declaration: string; body: string } {
    const match = signature.exec(source);
    if (!match) throw new Error('Required native fixture declaration missing');
    const open = source.indexOf('{', match.index + match[0].length);
    if (open < 0) throw new Error('Required native fixture body missing');
    let depth = 1;
    for (let index = open + 1; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0)
            return { declaration: source.slice(match.index, index + 1), body: source.slice(open + 1, index) };
    }
    throw new Error('Required native fixture body unbalanced');
}

const PHYSICAL = swiftDeclaration(
    DIRECTORY_SOURCE,
    /private static func physicalDirectory\(_ directory: URL\) throws -> URL\s*/,
);
const REQUIRE_TYPE = swiftDeclaration(
    DIRECTORY_SOURCE,
    /private static func requireType\(_ url: URL, _ type: FileAttributeType\) throws\s*/,
);

const FIXTURE_SWIFT = `
import Foundation
import Darwin
import SQLite3

enum DmAccountDirectoryError: Error { case unavailable }

enum NativePathFixture {
    ${REQUIRE_TYPE.declaration}
    ${PHYSICAL.declaration}

    static func resolve(_ directory: URL) throws -> URL {
        try physicalDirectory(directory)
    }
}

func refused(_ url: URL) -> Bool {
    do { _ = try NativePathFixture.resolve(url); return false }
    catch { return true }
}

func sqliteOpened(_ url: URL) -> Bool {
    var database: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW
    let result = url.path.withCString { sqlite3_open_v2($0, &database, flags, nil) }
    if let database { _ = sqlite3_close(database) }
    return result == SQLITE_OK
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let physical = root.appendingPathComponent("physical/Application Support", isDirectory: true)
let alias = root.appendingPathComponent("alias/Application Support", isDirectory: true)
let canonical = try NativePathFixture.resolve(alias)
let direct = try NativePathFixture.resolve(physical)
let result: [String: Bool] = [
    "ancestorAliasResolved": canonical.path == physical.path && canonical.path != alias.path,
    "physicalUnchanged": direct.path == physical.path,
    "aliasSQLiteRefused": !sqliteOpened(alias.appendingPathComponent("path-fixture.sqlite")),
    "physicalSQLiteOpened": sqliteOpened(canonical.appendingPathComponent("path-fixture.sqlite")),
    "missingDirectoryRefused": refused(root.appendingPathComponent("physical/missing", isDirectory: true)),
    "nonFileURLRefused": refused(URL(string: "https://invalid.example/native-path-fixture")!),
    "linkedLeafRefused": refused(root.appendingPathComponent("linked-leaf", isDirectory: true)),
    "regularLeafRefused": refused(root.appendingPathComponent("regular-leaf"))
]
let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(output)
`;

function successfulProcess(program: string, args: string[], timeout: number): string {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 });
    // Do not print native error strings or paths; this synthetic fixture emits booleans only.
    expect(result.error, 'bounded local fixture process must complete').toBeUndefined();
    expect(result.signal, 'bounded local fixture process must not time out').toBeNull();
    expect(result.status, 'local fixture compiler/runtime must succeed').toBe(0);
    return result.stdout;
}

beforeAll(() => {
    temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
    chmodSync(temporaryRoot, 0o700);
    const physical = join(temporaryRoot, 'physical');
    mkdirSync(join(physical, 'Application Support'), { recursive: true, mode: 0o700 });
    symlinkSync(physical, join(temporaryRoot, 'alias'), 'dir');
    symlinkSync(join(physical, 'Application Support'), join(temporaryRoot, 'linked-leaf'), 'dir');
    writeFileSync(join(temporaryRoot, 'regular-leaf'), 'synthetic path fixture only\n', { mode: 0o600, flag: 'wx' });
    const source = join(temporaryRoot, 'NativePathFixture.swift');
    const executable = join(temporaryRoot, 'native-path-fixture');
    writeFileSync(source, FIXTURE_SWIFT, { mode: 0o600, flag: 'wx' });
    mkdirSync(join(temporaryRoot, 'module-cache'), { mode: 0o700 });
    successfulProcess(
        '/usr/bin/xcrun',
        [
            'swiftc',
            '-module-name',
            'ThalassaNativePathFixture',
            '-module-cache-path',
            join(temporaryRoot, 'module-cache'),
            source,
            '-o',
            executable,
        ],
        30_000,
    );
    const parsed: unknown = JSON.parse(successfulProcess(executable, [temporaryRoot], 5_000));
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    expect(Array.isArray(parsed)).toBe(false);
    observations = parsed as Record<string, unknown>;
}, 40_000);

afterAll(() => {
    if (!temporaryRoot) return;
    const parent = realpathSync(tmpdir());
    // Delete only this exact mkdtemp-created disposable root, never an app or checkout.
    if (dirname(temporaryRoot) !== parent || !basename(temporaryRoot).startsWith(TEMP_PREFIX))
        throw new Error('Unsafe native path fixture cleanup target');
    rmSync(temporaryRoot, { recursive: true, force: false });
});

describe('research account directory physical path — local helper fixture only', () => {
    it('resolves only an existing directory and refuses the original symlink leaf before realpath', () => {
        const originalTypeCheck = PHYSICAL.body.indexOf('try requireType(directory, .typeDirectory)');
        const resolution = PHYSICAL.body.indexOf('Darwin.realpath(source, nil)');
        expect(originalTypeCheck).toBeGreaterThanOrEqual(0);
        expect(resolution).toBeGreaterThan(originalTypeCheck);
        expect(PHYSICAL.body).toContain('try requireType(physical, .typeDirectory)');
        expect(REQUIRE_TYPE.body).toContain('attributesOfItem(atPath: url.path)[.type]');
        expect(REQUIRE_TYPE.body).toContain('== type');
        expect(PHYSICAL.body).not.toContain('resolvingSymlinksInPath');
    });

    it('uses the helper in both directory creation and reopening without removing SQLite NOFOLLOW', () => {
        const create = swiftDeclaration(DIRECTORY_SOURCE, /static func create\(parentDirectory: URL,/).body;
        const reopen = swiftDeclaration(DIRECTORY_SOURCE, /static func reopen\(directory: URL,/).body;
        expect(create).toContain('let parent = try physicalDirectory(parentDirectory)');
        expect(create).toContain('let directory = parent.appendingPathComponent(');
        expect(reopen).toContain('let canonical = try physicalDirectory(directory)');
        expect(reopen).toContain('directory: canonical.appendingPathComponent(');
        expect(STORE_SOURCE).toContain('SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW');
        expect(STORE_SOURCE).toContain('sqlite3_open_v2(databaseURL.path, &database, flags, nil)');
    });

    it('passes actual ancestor-alias and refused-leaf checks while SQLite keeps its no-follow protection', () => {
        expect(observations).toEqual({
            ancestorAliasResolved: true,
            physicalUnchanged: true,
            aliasSQLiteRefused: true,
            physicalSQLiteOpened: true,
            missingDirectoryRefused: true,
            nonFileURLRefused: true,
            linkedLeafRefused: true,
            regularLeafRefused: true,
        });
    });
});
