#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = cf21a611c6b22db62449bc1658e7ae8b931476be
test "$RANGE_CONTROLLER_SHA" = de30eabb7103bc1f4db71c83214820dfb5c48673
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$RANGE_CONTROLLER_SHA" HEAD
git -C controls merge-base --is-ancestor "$PROOF_SOURCE_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
policy="$PWD/controls/ci/arome142-range-diagnostic"
proof="$RUNNER_TEMP/arome142-range-diagnostic-evidence"
stage="$RUNNER_TEMP/arome142-range-diagnostic-readonly"
fixture_parent="$RUNNER_TEMP/arome142-range-diagnostic-generated-only"
test -d "$proof"
test ! -e "$stage"
test ! -e "$fixture_parent"
mkdir -m700 "$proof/native"
mkdir -m755 "$stage" "$stage/tools" "$stage/source" "$stage/policy" "$fixture_parent"
mkdir -p "$stage/source/tools/arome142/native-tests"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$RANGE_CONTROLLER_SHA" > "$proof/controller-source.txt"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
python "$policy/retained_extract.py" --archive "$RUNNER_TEMP/arome142-range-retained.zip" --output "$stage/retained"
cp "$stage/retained/verified-retained.json" "$proof/verified-retained.json"
cp "$policy/NCALED-catalogue.json" "$policy/mask-native-proof.json" "$policy/h000-native-proof.json" "$stage/policy/"
cp "$policy/source-manifest.json" "$stage/"
cp "$stage/source-manifest.json" "$proof/native-source-manifest.json"
for file in native.py catalogue.py native-requirements.lock static_tiles.py; do
    cp "source/tools/arome142/$file" "$stage/source/tools/arome142/$file"
done
cp source/tools/arome142/native-tests/test_native.py "$stage/source/tools/arome142/native-tests/"
for file in complete49.py retained_range_diagnostic.py constant_original.py corrected_original_native.py; do
    cp "controls/tools/arome142/$file" "$stage/tools/"
done
cp "$policy/original_pilot_native.py" "$policy/run_native_fixtures.py" "$stage/tools/"
cp source/tools/arome142/catalogue.py "$stage/tools/"
python_path="$(command -v python)"
timeout --signal=TERM --kill-after=2s 15s sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$python_path" -E -s -B "$policy/runtime_manifest_tests.py" 2>&1 | tee "$proof/posix-link-fixtures10.txt"
export AROME_PILOT_CATALOGUE="$stage/policy/NCALED-catalogue.json"
export AROME_H000_PROOF="$stage/policy/h000-native-proof.json"
export AROME_MASK_PROOF="$stage/policy/mask-native-proof.json"
export AROME_H000_ORIGINAL="$stage/retained/originals/hour-000.grib2"
export AROME_MASK_ORIGINAL="$stage/retained/originals/mask.grib2"
python -B -m unittest discover -s controls/tools/arome142/complete-tests -p 'test_*.py' -v 2>&1 | tee "$proof/complete26.txt"
python -B -m unittest discover -s controls/tools/arome142/range-tests -p 'test_*.py' -v 2>&1 | tee "$proof/range8.txt"
python -B -m unittest discover -s controls/tools/arome142/constant-tests -p 'test_*.py' -v 2>&1 | tee "$proof/constant48.txt"
python -B -m unittest discover -s controls/tools/arome142/corrected-tests -p 'test_*.py' -v 2>&1 | tee "$proof/controller15.txt"
python -B -m unittest discover -s source/tools/arome142 -p 'test_*.py' -v 2>&1 | tee "$proof/source18.txt"
test "$(sha256sum "$stage/source/tools/arome142/native-requirements.lock" | cut -d' ' -f1)" = cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64
python -m venv --copies "$stage/runtime"
"$stage/runtime/bin/python" -m pip --isolated install --disable-pip-version-check --require-hashes --only-binary=:all: -r "$stage/source/tools/arome142/native-requirements.lock" 2>&1 | tee "$proof/install.txt"
"$stage/runtime/bin/python" -m pip --isolated check > "$proof/pip-check.txt"
"$stage/runtime/bin/python" -m pip --isolated freeze > "$proof/packages.txt"
sudo chown -R root:root "$stage"
test -L "$stage/runtime/lib64"
test "$(readlink "$stage/runtime/lib64")" = lib
sudo chown -h root:root "$stage/runtime/lib64"
sudo chmod -R a+rX,a-w "$stage"
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-manifest.json"
user_name="$(id -un)"
group_name="$(id -gn)"
test "$(id -u)" != 0
units=()
cleanup() {
    local failed=0 load
    for unit in "${units[@]}"; do
        load="$(sudo systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
        if [[ "$load" != not-found && -n "$load" ]]; then sudo systemctl stop "$unit" || failed=1; fi
        sudo systemctl show "$unit" --property=LoadState --property=ActiveState --property=SubState --property=MainPID > "$proof/cleanup-${unit}.txt" 2>&1 || true
        if grep -q '^MainPID=0$' "$proof/cleanup-${unit}.txt" && { grep -q '^LoadState=not-found$' "$proof/cleanup-${unit}.txt" || grep -q '^ActiveState=inactive$' "$proof/cleanup-${unit}.txt"; }; then :; else failed=1; fi
    done
    return "$failed"
}
trap cleanup EXIT
common=(--quiet --wait --pipe --collect --service-type=exec
    --property="User=$user_name" --property="Group=$group_name" --property=UMask=0077
    --property=MemoryMax=2147483648 --property=MemorySwapMax=0 --property=TasksMax=16
    --property=CPUQuota=100% --property=LimitAS=2147483648 --property=LimitFSIZE=16777216
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=AmbientCapabilities=
    --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes
    --property=PrivateDevices=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes
    --property=RestrictRealtime=yes --property=KillMode=control-group --property=TimeoutStopSec=2s
    --property=SendSIGKILL=yes --property="ReadWritePaths=$proof" --property="ReadOnlyPaths=$stage"
    --property="WorkingDirectory=$stage/tools")
clean=(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1)
fixture="arome142-range-diagnostic-fixture-${GITHUB_RUN_ID}.service"
units+=("$fixture")
sudo systemd-run --unit="$fixture" "${common[@]}" --property=RuntimeMaxSec=300s \
    --property="ReadWritePaths=$proof $fixture_parent" \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" AROME_NATIVE_FIXTURE_DIR="$fixture_parent/roundtrip" \
    "$stage/runtime/bin/python" -E -s -B "$stage/tools/run_native_fixtures.py" \
    --source "$stage/source" --output "$proof/native/kernel-before-generated-fixtures.json" \
    2>&1 | tee "$proof/compiled-fixtures4.txt"
cp "$fixture_parent/roundtrip/proof.json" "$proof/generated-fixture-proof.json"
diagnostic="arome142-range-diagnostic-native-${GITHUB_RUN_ID}.service"
units+=("$diagnostic")
set +e
sudo systemd-run --unit="$diagnostic" "${common[@]}" --property=RuntimeMaxSec=120s \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/retained_range_diagnostic.py" \
    --source "$stage/source" --originals "$stage/retained/originals" \
    --receipt "$stage/retained/sources.json" --capture "$stage/retained/capture.json" \
    --catalogue "$stage/policy/NCALED-catalogue.json" --manifest "$stage/source-manifest.json" \
    --h000-proof "$stage/policy/h000-native-proof.json" --mask-proof "$stage/policy/mask-native-proof.json" \
    --output "$proof/native/physical-range-diagnostic.json" 2>&1 | tee "$proof/native-diagnostic.txt"
statuses=("${PIPESTATUS[@]}")
set -e
printf '%s\n' "${statuses[0]}" > "$proof/native-process-exit.txt"
test "${statuses[0]}" = 1
test "${statuses[1]}" = 0
python - "$proof/native/physical-range-diagnostic.json" "$proof/native-diagnostic.txt" <<'PYVERIFY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['diagnosticOnly'] is True and r['originalError']=='original field physical range'
assert r['originalErrorType']=='AdmissionError' and r['originalQualificationClockRenewed'] is False
assert r['full49HourCohortAdmitted'] is False and r['newQualificationAttempt'] is False
assert r['all50OriginalDigestsValidatedBeforeArrays'] is True and r['providerRequests']==0
assert r['published'] is False and r['installed'] is False
assert len(r['rangeEvidence']['samples'])<=16 and r['rangeEvidence']['valuesClampedOrChanged'] is False
assert r['originalExpiresAt']=='2026-10-17T18:00:00Z'
assert r['scientificSource']=='cf21a611c6b22db62449bc1658e7ae8b931476be'
assert r['unchangedNativeSourceLine']==143 and r['field'] in ('u10','v10','msl','t2m','rh2m')
v=r['rangeEvidence']
assert v['cells']==255811 and v['finiteCells']+v['missingNaNCells']+v['nonfinitePresentCells']==255811
assert v['belowMinimumCells']+v['aboveMaximumCells']+v['nonfinitePresentCells']>0
log=open(sys.argv[2]).read()
assert log.count('Traceback (most recent call last):')==1
assert log.count('catalogue.AdmissionError: original field physical range')==1
print('Diagnostic refusal preserved; no qualification or publication')
PYVERIFY
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
