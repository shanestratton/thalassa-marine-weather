import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const lockfile = new URL('../ios/App/Gemfile.lock', import.meta.url);
const lockContents = readFileSync(lockfile, 'utf8');
const requiredBundler = lockContents.match(/\nBUNDLED WITH\n\s+([^\s]+)\s*$/)?.[1];

if (!requiredBundler) {
    console.error('Unable to read the pinned Bundler version from ios/App/Gemfile.lock.');
    process.exit(1);
}

const currentPath = process.env.PATH ?? '';
const currentDirectories = currentPath.split(delimiter).filter(Boolean);
const rubyDirectories = [
    ...currentDirectories,
    ...(process.platform === 'darwin' ? ['/opt/homebrew/opt/ruby/bin', '/usr/local/opt/ruby/bin'] : []),
];

const seen = new Set();
let selectedRubyDirectory = null;

for (const directory of rubyDirectories) {
    if (seen.has(directory)) continue;
    seen.add(directory);

    const bundle = join(directory, process.platform === 'win32' ? 'bundle.bat' : 'bundle');
    try {
        accessSync(bundle, constants.X_OK);
    } catch {
        continue;
    }

    const version = spawnSync(bundle, ['--version'], {
        encoding: 'utf8',
        env: process.env,
    });
    const reportedVersion =
        `${version.stdout ?? ''}\n${version.stderr ?? ''}`.match(/Bundler version\s+([^\s]+)/)?.[1] ??
        version.stdout?.trim().match(/^(\d+(?:\.\d+)+)$/)?.[1];

    if (version.status === 0 && reportedVersion === requiredBundler) {
        selectedRubyDirectory = directory;
        break;
    }
}

if (!selectedRubyDirectory) {
    console.error(
        `Capacitor iOS sync requires Bundler ${requiredBundler}. Install the pinned Bundler or add its Ruby bin directory to PATH.`,
    );
    process.exit(1);
}

if (process.argv.includes('--check')) {
    console.log(`Bundler ${requiredBundler} is ready for Capacitor iOS sync.`);
    process.exit(0);
}

const cap = process.platform === 'win32' ? 'cap.cmd' : 'cap';
const sync = spawnSync(cap, ['sync'], {
    stdio: 'inherit',
    env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PATH: [selectedRubyDirectory, currentPath].filter(Boolean).join(delimiter),
    },
});

if (sync.error) {
    console.error(`Unable to start Capacitor sync: ${sync.error.message}`);
    process.exit(1);
}

process.exit(sync.status ?? 1);
