/** A bounded source gate for the single reviewed unsigned Mac diagnostic.
 * This does not authorize arbitrary Mac jobs or replace immutable action pins,
 * global permissions, client-secret or signed-release guards. */
export function isReviewedUnsignedNative139Workflow(relative, source) {
    if (relative.replaceAll('\\', '/') !== '.github/workflows/unsigned-native-139.yml') return false;
    const text = source.replace(/^\s*#.*$/gm, '');
    if (
        /secrets\s*[.[]|github\.token|\b(?:GH_TOKEN|GITHUB_TOKEN|ASC_[A-Z_]+|IOS_DEV_CERT[A-Z_]*|SENTRY_AUTH_TOKEN)\b/.test(
            text,
        ) ||
        /\b(?:codesign|security|altool|notarytool)\b|-(?:exportArchive|archivePath|allowProvisioningUpdates|authenticationKey\w*)\b|\bupload\s*:\s*true\b/.test(
            text,
        ) ||
        /\b(?:inputs|environment)\s*:/.test(text) ||
        /CODE_SIGNING_ALLOWED\s*=\s*(?!NO\b)/.test(text)
    )
        return false;
    if (
        !/^on:\s*\n\s+workflow_dispatch:\s*\n\s+push:\s*\n\s+branches: \[codex\/build-139-unsigned-native\]\s*\n\s+paths: \[\.github\/workflows\/unsigned-native-139\.yml\]\s*$/m.test(
            text,
        ) ||
        !/^permissions:\s*\n\s+contents: read\s*$/m.test(text) ||
        !text.includes(
            "if: github.repository == 'shanestratton/thalassa-marine-weather' && github.actor == 'shanestratton' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/codex/build-139-unsigned-native'))",
        ) ||
        !text.includes('DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer') ||
        !text.includes("VITE_APP_BUILD: '139'") ||
        !text.includes('node-version: 24') ||
        (text.match(/^\s*runs-on:/gm) ?? []).length !== 1 ||
        !/^\s*runs-on: macos-26\s*$/m.test(text) ||
        (text.match(/^\s+persist-credentials: false\s*$/gm) ?? []).length !== 2 ||
        !/^\s+ref: [a-f0-9]{40}\s*$/m.test(text)
    )
        return false;
    const xcodeLines = text.split('\n').filter((line) => /\bxcodebuild\b/.test(line));
    if (xcodeLines.length !== 3 || xcodeLines.filter((line) => /xcodebuild -version >/.test(line)).length !== 1)
        return false;
    const compile = xcodeLines.filter((line) => !/xcodebuild -version/.test(line));
    if (
        compile.length !== 2 ||
        !compile.every((line) => /CODE_SIGNING_ALLOWED=NO build\s*$/.test(line)) ||
        !compile.some((line) => line.includes("-destination 'generic/platform=iOS Simulator'")) ||
        !compile.some(
            (line) => line.includes("-target 'ThalassaWatch Watch App'") && line.includes('-sdk watchsimulator'),
        ) ||
        !text.includes('npm run ship:beta') ||
        (text.match(/uses: actions\/upload-artifact@/g) ?? []).length !== 1 ||
        !/^\s+path: \|\s*\n\s+\$\{\{ runner.temp \}\}\/native139-evidence\/\*\.txt\s*\n\s+\$\{\{ runner.temp \}\}\/native139-evidence\/\*\.json\s*\n\s+if-no-files-found: error\s*$/m.test(
            text,
        )
    )
        return false;
    return true;
}
