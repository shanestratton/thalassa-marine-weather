#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = bbd57495546fa93bba7316f414b7d8975cf4dbec
test "$RH_CONTROLLER_SHA" = e8137e44ee061133c41a9053e585ec3a25d0df7e
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$RH_CONTROLLER_SHA" HEAD
git -C controls merge-base --is-ancestor "$PROOF_SOURCE_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
policy="$PWD/controls/ci/arome142-rh-qualified"
proof="$RUNNER_TEMP/arome142-rh-qualified-evidence"
stage="$RUNNER_TEMP/arome142-rh-qualified-readonly"
js_stage="$RUNNER_TEMP/arome142-rh-js-readonly"
fixture_parent="$RUNNER_TEMP/arome142-rh-qualified-generated-only"
native_parent="$RUNNER_TEMP/arome142-rh-qualified-local-only"
phase_stage="$RUNNER_TEMP/arome142-rh-phase-readonly"
test -d "$proof"
for path in "$stage" "$js_stage" "$fixture_parent" "$native_parent" "$phase_stage"; do test ! -e "$path"; done
mkdir -m700 "$proof/native"
mkdir -m755 "$stage" "$stage/tools" "$stage/source" "$stage/policy" "$js_stage" "$js_stage/source" "$fixture_parent" "$native_parent" "$phase_stage"
mkdir -p "$stage/source/tools/arome142/native-tests"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$RH_CONTROLLER_SHA" > "$proof/controller-source.txt"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
python "$policy/retained_extract.py" --archive "$RUNNER_TEMP/arome142-rh-retained.zip" --output "$stage/retained"
cp "$stage/retained/verified-retained.json" "$proof/verified-retained.json"
cp "$policy/NCALED-catalogue.json" "$policy/mask-native-proof.json" "$policy/h000-native-proof.json" "$policy/raw-survey.json" "$stage/policy/"
cp "$policy/source-manifest.json" "$stage/"
cp "$stage/source-manifest.json" "$proof/native-source-manifest.json"
for file in native.py catalogue.py native-requirements.lock static_tiles.py; do cp "source/tools/arome142/$file" "$stage/source/tools/arome142/$file"; done
for file in test_native.py test_rh_display_native.py; do cp "source/tools/arome142/native-tests/$file" "$stage/source/tools/arome142/native-tests/$file"; done
for file in complete49.py retained_range_diagnostic.py retained_range_survey.py constant_original.py corrected_original_native.py rh_retained_qualification.py; do cp "controls/tools/arome142/$file" "$stage/tools/"; done
cp "$policy/original_pilot_native.py" "$policy/run_native_fixtures.py" "$policy/js_gate.py" "$stage/tools/"
cp source/tools/arome142/catalogue.py "$stage/tools/"
for file in services/weather/aromeDomains.ts services/weather/aromePointContract.ts services/weather/aromeStaticContract.ts supabase/functions/_shared/arome-upstream.ts tools/arome142/prove_rh_static_interop.mjs; do
    mkdir -p "$js_stage/source/$(dirname "$file")"
    cp "source/$file" "$js_stage/source/$file"
done
cp "$(command -v node)" "$js_stage/node"
cp "$policy/js_interop.mjs" "$js_stage/js_interop.mjs"
python - "$policy/js-source-files.json" "$js_stage" <<'PYJS'
import hashlib,json,pathlib,sys
expected=json.loads(pathlib.Path(sys.argv[1]).read_bytes());stage=pathlib.Path(sys.argv[2]);node=stage/'node'
assert node.stat().st_size<=128*1024**2
for name,sha in expected.items():assert hashlib.sha256((stage/'source'/name).read_bytes()).hexdigest()==sha
with node.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
with (stage/'node-source-manifest.json').open('x') as out:json.dump({'nodeSha256':digest,'files':expected},out,sort_keys=True)
PYJS
cp "$js_stage/node-source-manifest.json" "$proof/js-source-manifest.json"
python_path="$(command -v python)"
python -B "$policy/cleanup_fixture_tests.py" 2>&1 | tee "$proof/cleanup-fixtures5.txt"
timeout --signal=TERM --kill-after=2s 15s sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$python_path" -E -s -B "$policy/runtime_manifest_tests.py" 2>&1 | tee "$proof/posix-link-fixtures10.txt"
export AROME_PILOT_CATALOGUE="$stage/policy/NCALED-catalogue.json"
export AROME_H000_PROOF="$stage/policy/h000-native-proof.json"
export AROME_MASK_PROOF="$stage/policy/mask-native-proof.json"
export AROME_H000_ORIGINAL="$stage/retained/originals/hour-000.grib2"
export AROME_MASK_ORIGINAL="$stage/retained/originals/mask.grib2"
python -B -m unittest discover -s controls/tools/arome142/complete-tests -p 'test_*.py' -v 2>&1 | tee "$proof/complete26.txt"
python -B -m unittest discover -s controls/tools/arome142/range-tests -p 'test_*.py' -v 2>&1 | tee "$proof/range13.txt"
python -B -m unittest discover -s controls/tools/arome142/rh-tests -p 'test_*.py' -v 2>&1 | tee "$proof/rh26.txt"
python -B -m unittest discover -s controls/tools/arome142/constant-tests -p 'test_*.py' -v 2>&1 | tee "$proof/constant48.txt"
python -B -m unittest discover -s controls/tools/arome142/corrected-tests -p 'test_*.py' -v 2>&1 | tee "$proof/controller15.txt"
python -B -m unittest discover -s source/tools/arome142 -p 'test_*.py' -v 2>&1 | tee "$proof/source18.txt"
test "$(sha256sum "$stage/source/tools/arome142/native-requirements.lock" | cut -d' ' -f1)" = cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64
python -m venv --copies "$stage/runtime"
"$stage/runtime/bin/python" -m pip --isolated install --disable-pip-version-check --require-hashes --only-binary=:all: -r "$stage/source/tools/arome142/native-requirements.lock" 2>&1 | tee "$proof/install.txt"
"$stage/runtime/bin/python" -m pip --isolated check > "$proof/pip-check.txt"
"$stage/runtime/bin/python" -m pip --isolated freeze > "$proof/packages.txt"
sudo chown -R root:root "$stage" "$js_stage"
test -L "$stage/runtime/lib64"; test "$(readlink "$stage/runtime/lib64")" = lib
sudo chown -h root:root "$stage/runtime/lib64"
sudo chmod -R a+rX,a-w "$stage" "$js_stage"
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-manifest.json"
python "$policy/runtime_manifest.py" "$js_stage" "$proof/read-only-js-manifest.json"
user_name="$(id -un)"; group_name="$(id -gn)"; test "$(id -u)" != 0
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
# BEGIN cleanup-status
cleanup_exit() {
    local original_status=$?
    trap - EXIT
    if cleanup; then :; else
        if [[ "$original_status" -eq 0 ]]; then original_status=1; fi
    fi
    exit "$original_status"
}
trap cleanup_exit EXIT
# END cleanup-status
common=(--quiet --wait --pipe --collect --service-type=exec
    --property="User=$user_name" --property="Group=$group_name" --property=UMask=0077
    --property=MemoryMax=2147483648 --property=MemorySwapMax=0 --property=TasksMax=16
    --property=CPUQuota=100% --property=LimitAS=2147483648 --property=LimitFSIZE=16777216
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=AmbientCapabilities=
    --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes
    --property=PrivateDevices=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes
    --property=RestrictRealtime=yes --property=KillMode=control-group --property=TimeoutStopSec=2s
    --property=SendSIGKILL=yes --property="ReadWritePaths=$proof" --property="ReadOnlyPaths=$stage $js_stage"
    --property="WorkingDirectory=$stage/tools" --property=PrivateNetwork=yes
    --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX)
clean=(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1)
for kind in base rh; do
    fixture="arome142-rh-qualified-${kind}-${GITHUB_RUN_ID}.service"; units+=("$fixture")
    sudo systemd-run --unit="$fixture" "${common[@]}" --property=RuntimeMaxSec=300s \
        --property="ReadWritePaths=$proof $fixture_parent" \
        "${clean[@]}" AROME_NATIVE_FIXTURE_DIR="$fixture_parent/base" AROME_RH_NATIVE_FIXTURE_DIR="$fixture_parent/rh" \
        "$stage/runtime/bin/python" -E -s -B "$stage/tools/run_native_fixtures.py" --kind "$kind" \
        --source "$stage/source" --output "$proof/native/kernel-before-generated-${kind}.json" \
        2>&1 | tee "$proof/compiled-fixtures-${kind}.txt"
done
cp "$fixture_parent/base/proof.json" "$proof/generated-base-proof.json"
cp "$fixture_parent/rh/rh-proof.json" "$proof/generated-rh-proof.json"
sudo chown -R root:root "$fixture_parent/rh/cohort"
sudo chmod -R a+rX,a-w "$fixture_parent/rh/cohort"
js="arome142-rh-qualified-js-${GITHUB_RUN_ID}.service"; units+=("$js")
sudo systemd-run --unit="$js" "${common[@]}" --property=RuntimeMaxSec=30s --property=LimitAS=17179869184 \
    --property="ReadWritePaths=$proof $fixture_parent/rh" --property="ReadOnlyPaths=$fixture_parent/rh/cohort" \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/js_gate.py" \
    --node "$js_stage/node" --bootstrap "$js_stage/js_interop.mjs" --source "$js_stage/source" \
    --manifest "$js_stage/node-source-manifest.json" --fixture "$fixture_parent/rh" \
    --output "$proof/native/kernel-before-js.json" 2>&1 | tee "$proof/generated-js-interop.txt"
cp "$fixture_parent/rh/rh-interop-proof.json" "$fixture_parent/rh/js-boundary-proof.json" "$proof/"
# New phase starts only after all4+9 compiled fixtures and actual TS interop pass.
df -B1 "$native_parent" > "$proof/qualification-disk.txt"
python - "$native_parent" <<'PYDISK'
import shutil,sys
assert shutil.disk_usage(sys.argv[1]).free >= 3*1024**3
PYDISK
python -B controls/tools/arome142/rh_retained_qualification.py --create-phase "$proof/new-phase.json"
sudo cp "$proof/new-phase.json" "$phase_stage/phase.json"
sudo chown -R root:root "$phase_stage"; sudo chmod -R a+rX,a-w "$phase_stage"
python "$policy/runtime_manifest.py" "$phase_stage" "$proof/read-only-phase-manifest.json"
remaining="$(python -B controls/tools/arome142/rh_retained_qualification.py --remaining-phase "$phase_stage/phase.json")"
printf '%s\n' "$remaining" > "$proof/native-remaining-seconds.txt"
native="arome142-rh-qualified-native-${GITHUB_RUN_ID}.service"; units+=("$native")
sudo systemd-run --unit="$native" "${common[@]}" --property="RuntimeMaxSec=${remaining}s" \
    --property="ReadWritePaths=$proof $native_parent" --property="ReadOnlyPaths=$phase_stage" \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/rh_retained_qualification.py" \
    --source "$stage/source" --originals "$stage/retained/originals" \
    --receipt "$stage/retained/sources.json" --capture "$stage/retained/capture.json" \
    --catalogue "$stage/policy/NCALED-catalogue.json" --manifest "$stage/source-manifest.json" \
    --h000-proof "$stage/policy/h000-native-proof.json" --mask-proof "$stage/policy/mask-native-proof.json" \
    --survey "$stage/policy/raw-survey.json" --phase "$phase_stage/phase.json" \
    --out "$native_parent/cohort" --output "$proof/native/retained-qualified-rh-partial.json" \
    2>&1 | tee "$proof/retained-qualified-native.txt"
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-after.json"
python "$policy/runtime_manifest.py" "$js_stage" "$proof/read-only-js-after.json"
python "$policy/runtime_manifest.py" "$phase_stage" "$proof/read-only-phase-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-js-manifest.json" "$proof/read-only-js-after.json"
cmp "$proof/read-only-phase-manifest.json" "$proof/read-only-phase-after.json"
python -B controls/tools/arome142/rh_retained_qualification.py --remaining-phase "$phase_stage/phase.json" > "$proof/final-phase-remaining-seconds.txt"
test -z "$(git -C source status --porcelain)"; test -z "$(git -C controls status --porcelain)"
