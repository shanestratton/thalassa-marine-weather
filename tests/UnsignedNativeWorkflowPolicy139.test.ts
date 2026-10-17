// @vitest-environment node
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { isReviewedUnsignedNative139Workflow } from '../scripts/unsigned-native139-policy.mjs';

const name = '.github/workflows/unsigned-native-139.yml';
const source = fs.readFileSync(name, 'utf8');

it('admits only the actual reviewed unsigned workflow without changing the signed path', () => {
    expect(isReviewedUnsignedNative139Workflow(name, source)).toBe(true);
    for (const other of [
        '.github/workflows/unreviewed-mac.yml',
        '.github/workflows/ios-testflight.yml',
        'unsigned-native-139.yml',
    ])
        expect(isReviewedUnsignedNative139Workflow(other, source)).toBe(false);
    const gate = fs.readFileSync('scripts/check-beta-readiness.mjs', 'utf8');
    expect(gate).toContain("path.basename(relative) === 'ios-testflight.yml' && runner === 'macos-26'");
    expect(gate).toContain('isReviewedUnsignedNative139Workflow(');
});

it.each([
    ['wrong actor', source.replace("github.actor == 'shanestratton'", "github.actor != 'shanestratton'")],
    ['wrong branch', source.replace('branches: [codex/build-139-unsigned-native]', 'branches: [master]')],
    ['extra Mac job', source + '\n    another:\n        runs-on: macos-26\n'],
    ['floating runner', source.replace('runs-on: macos-26', 'runs-on: macos-latest')],
    ['mutable source', source.replace(/ref: [a-f0-9]{40}/, 'ref: master')],
    ['persisted checkout credentials', source.replace('persist-credentials: false', 'persist-credentials: true')],
    ['signing flag', source.replace('CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_ALLOWED=YES')],
    ['removed unsigned flag', source.replace('CODE_SIGNING_ALLOWED=NO build', 'build')],
    ['secret context', source + '\n# ignored comment\nextra: ${{ secrets.APPLE_KEY }}\n'],
    ['secret bracket syntax', source + '\nextra: ${{ secrets["APPLE_KEY"] }}\n'],
    ['token environment', source + '\nGH_TOKEN: ${{ github.token }}\n'],
    ['signing identity', source + '\nrun: codesign --sign identity app\n'],
    ['keychain', source + '\nrun: security import certificate\n'],
    ['archive', source.replace('CODE_SIGNING_ALLOWED=NO build', 'CODE_SIGNING_ALLOWED=NO archive')],
    ['export', source + '\nrun: xcodebuild -exportArchive\n'],
    ['upload declaration', source + '\nupload: true\n'],
    ['Apple upload', source + '\nrun: xcrun altool --upload-app\n'],
    ['binary artifact', source.replace('native139-evidence/*.json', 'native139-evidence/*.ipa')],
    ['wildcard artifact', source.replace('native139-evidence/*.json', '**/*')],
    ['skipped production gate', source.replace('npm run ship:beta', 'npm run build')],
])('refuses %s in the unsigned exception', (_label, changed) => {
    expect(isReviewedUnsignedNative139Workflow(name, changed)).toBe(false);
});
