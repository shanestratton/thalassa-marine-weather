#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = cf21a611c6b22db62449bc1658e7ae8b931476be
test "$COMPLETE_CONTROLLER_SHA" = 011e7e543074e722e84594ce684bdc1913c44db2
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$COMPLETE_CONTROLLER_SHA" HEAD
git -C controls merge-base --is-ancestor "$PROOF_SOURCE_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
policy="$PWD/controls/ci/arome142-complete49"
proof="$RUNNER_TEMP/arome142-complete49-evidence"
stage="$RUNNER_TEMP/arome142-complete49-readonly"
input_stage="$RUNNER_TEMP/arome142-complete49-input-readonly"
fixture_parent="$RUNNER_TEMP/arome142-complete49-generated-only"
test -d "$proof"
test ! -e "$stage"
test ! -e "$input_stage"
test ! -e "$fixture_parent"
mkdir -m700 "$proof/state" "$proof/native"
mkdir -m755 "$stage" "$stage/tools" "$stage/source" "$stage/policy" "$fixture_parent"
mkdir -p "$stage/source/tools/arome142/native-tests"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$COMPLETE_CONTROLLER_SHA" > "$proof/controller-source.txt"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
python "$policy/retained_sources.py" --h000-archive "$RUNNER_TEMP/arome142-h000-retained.zip" \
    --mask-archive "$RUNNER_TEMP/arome142-mask-retained.zip" --output "$stage/retained"
cp "$stage/retained/verified-retained.json" "$proof/verified-retained.json"
cp "$policy/NCALED-catalogue.json" "$policy/ticket.json" "$policy/h000-native-proof.json" "$stage/policy/"
cp "$policy/source-manifest.json" "$stage/"
cp "$stage/policy/ticket.json" "$proof/reviewed-fixed48-ticket.json"
cp "$stage/source-manifest.json" "$proof/native-source-manifest.json"
for file in native.py catalogue.py native-requirements.lock static_tiles.py; do
    cp "source/tools/arome142/$file" "$stage/source/tools/arome142/$file"
done
cp source/tools/arome142/native-tests/test_native.py "$stage/source/tools/arome142/native-tests/"
for file in complete49.py complete49_native.py constant_original.py corrected_original_native.py; do
    cp "controls/tools/arome142/$file" "$stage/tools/"
done
cp "$policy/original_pilot_native.py" "$policy/prepare_inputs.py" "$policy/run_native_fixtures.py" "$stage/tools/"
cp source/tools/arome142/catalogue.py "$stage/tools/"
python_path="$(command -v python)"
timeout --signal=TERM --kill-after=2s 15s sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$python_path" -E -s -B "$policy/runtime_manifest_tests.py" 2>&1 | tee "$proof/posix-link-fixtures10.txt"
export AROME_PILOT_CATALOGUE="$stage/policy/NCALED-catalogue.json"
export AROME_H000_PROOF="$stage/policy/h000-native-proof.json"
export AROME_MASK_PROOF="$stage/retained/mask-proof.json"
export AROME_H000_ORIGINAL="$stage/retained/h000.grib2"
export AROME_MASK_ORIGINAL="$stage/retained/mask.grib2"
python -B -m unittest discover -s controls/tools/arome142/complete-tests -p 'test_*.py' -v 2>&1 | tee "$proof/complete26.txt"
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
fixture="arome142-complete49-fixture-${GITHUB_RUN_ID}.service"
units+=("$fixture")
sudo systemd-run --unit="$fixture" "${common[@]}" --property=RuntimeMaxSec=300s \
    --property="ReadWritePaths=$proof $fixture_parent" \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" AROME_NATIVE_FIXTURE_DIR="$fixture_parent/roundtrip" \
    "$stage/runtime/bin/python" -E -s -B "$stage/tools/run_native_fixtures.py" \
    --source "$stage/source" --output "$proof/native/kernel-before-generated-fixtures.json" \
    2>&1 | tee "$proof/compiled-fixtures4.txt"
cp "$fixture_parent/roundtrip/proof.json" "$proof/generated-fixture-proof.json"
python - "$RUNNER_TEMP" "$proof/resource-before-provider-get.json" <<'PY'
import json,os,sys
from pathlib import Path
s=os.statvfs(sys.argv[1]); free=s.f_bavail*s.f_frsize
assert free >= 3*1024**3, 'threeGiB spare required for exact originals+scratch+boundedoutput+evidence'
Path(sys.argv[2]).write_text(json.dumps({'path':sys.argv[1],'freeBytes':free,'minimumFreeBytes':3*1024**3,'providerRequests':0})+'\n')
PY
kernel="arome142-complete49-kernel-${GITHUB_RUN_ID}.service"
units+=("$kernel")
sudo systemd-run --unit="$kernel" "${common[@]}" --property=RuntimeMaxSec=10s \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/original_pilot_native.py" \
    --kernel-only "$proof/native/kernel-before-fixed48-get.json" 2>&1 | tee "$proof/kernel-preflight.txt"
capture="arome142-complete49-capture-${GITHUB_RUN_ID}.service"
units+=("$capture")
sudo systemd-run --unit="$capture" "${common[@]}" --property=RuntimeMaxSec=1200s \
    "${clean[@]}" GITHUB_RUN_ATTEMPT=1 "$stage/runtime/bin/python" -E -s -B "$stage/tools/complete49.py" \
    --ledger "$proof/state/day.sqlite" --output "$proof/attempt" --catalogue "$stage/policy/NCALED-catalogue.json" \
    --ticket "$stage/policy/ticket.json" --h000 "$stage/retained/h000.grib2" --mask "$stage/retained/mask.grib2" \
    --h000-proof "$stage/policy/h000-native-proof.json" --mask-proof "$stage/retained/mask-proof.json" \
    2>&1 | tee "$proof/fixed48-parent.txt"
printf '0\n' > "$proof/capture-process-exit.txt"
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
    "$stage/runtime/bin/python" -E -s -B "$stage/tools/prepare_inputs.py" --capture "$proof/attempt" \
    --h000 "$stage/retained/h000.grib2" --mask "$stage/retained/mask.grib2" \
    --catalogue "$stage/policy/NCALED-catalogue.json" --out "$input_stage" > "$proof/root-readonly-original-copy.json"
python "$policy/runtime_manifest.py" "$input_stage" "$proof/read-only-original-manifest.json"
remaining="$(python - "$input_stage/capture-result.json" <<'PY'
import json,math,sys,time
r=json.load(open(sys.argv[1])); assert r['deadlineMonotonic']-r['startedMonotonic']==1200
remaining=math.floor(r['deadlineMonotonic']-time.monotonic())
assert 1<=remaining<=1200, 'no original whole-attempt time remains for native'
print(remaining)
PY
)"
printf '%s\n' "$remaining" > "$proof/native-runtime-remaining-seconds.txt"
native="arome142-complete49-native-${GITHUB_RUN_ID}.service"
units+=("$native")
sudo systemd-run --unit="$native" "${common[@]}" --property="RuntimeMaxSec=${remaining}s" \
    --property="ReadOnlyPaths=$stage $input_stage" \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/complete49_native.py" \
    --source "$stage/source" --inputs "$input_stage" --catalogue "$stage/policy/NCALED-catalogue.json" \
    --receipt "$input_stage/sources.json" --capture "$input_stage/capture-result.json" \
    --manifest "$stage/source-manifest.json" --h000-proof "$stage/policy/h000-native-proof.json" \
    --mask-proof "$stage/retained/mask-proof.json" --out "$proof/static" --output "$proof/native/full49-qualification.json" \
    2>&1 | tee "$proof/full49-native.txt"
printf '0\n' > "$proof/native-process-exit.txt"
python "$policy/runtime_manifest.py" "$input_stage" "$proof/read-only-original-after.json"
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-original-manifest.json" "$proof/read-only-original-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
