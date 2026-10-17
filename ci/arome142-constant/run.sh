#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = cf21a611c6b22db62449bc1658e7ae8b931476be
test "$CONSTANT_CONTROLLER_SHA" = 66969ef49ed50e283eeb47012dadcf86fe6cc1b3
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$CONSTANT_CONTROLLER_SHA" HEAD
git -C controls merge-base --is-ancestor "$PROOF_SOURCE_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
policy="$PWD/controls/ci/arome142-constant"
proof="$RUNNER_TEMP/arome142-constant-evidence"
stage="$RUNNER_TEMP/arome142-constant-readonly"
input_stage="$RUNNER_TEMP/arome142-constant-input-readonly"
test ! -e "$proof"
test ! -e "$stage"
test ! -e "$input_stage"
mkdir -m700 "$proof" "$proof/state" "$proof/native"
mkdir -m755 "$stage" "$stage/tools" "$stage/source" "$stage/policy"
mkdir -p "$stage/source/tools/arome142"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$CONSTANT_CONTROLLER_SHA" > "$proof/controller-source.txt"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
cp "$policy/NCALED-catalogue.json" "$stage/policy/"
cp "$policy/ticket.json" "$stage/policy/"
cp "$policy/h000-native-proof.json" "$stage/policy/"
cp "$policy/source-manifest.json" "$stage/"
cp "$stage/policy/ticket.json" "$proof/reviewed-one-constant-ticket.json"
cp "$stage/policy/h000-native-proof.json" "$proof/prior-actual-h000-native.json"
cp "$stage/source-manifest.json" "$proof/native-source-manifest.json"
for file in native.py catalogue.py native-requirements.lock; do
    cp "source/tools/arome142/$file" "$stage/source/tools/arome142/$file"
done
for file in constant_original.py constant_native.py corrected_original_native.py; do
    cp "controls/tools/arome142/$file" "$stage/tools/"
done
cp "$policy/original_pilot_native.py" "$stage/tools/"
cp source/tools/arome142/catalogue.py "$stage/tools/"
python_path="$(command -v python)"
timeout --signal=TERM --kill-after=2s 15s sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$python_path" -E -s -B "$policy/runtime_manifest_tests.py" 2>&1 | tee "$proof/posix-link-fixtures10.txt"
export AROME_PILOT_CATALOGUE="$stage/policy/NCALED-catalogue.json"
export AROME_H000_PROOF="$stage/policy/h000-native-proof.json"
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
        if grep -q '^MainPID=0$' "$proof/cleanup-${unit}.txt" && { grep -q '^LoadState=not-found$' "$proof/cleanup-${unit}.txt" || grep -q '^ActiveState=inactive$' "$proof/cleanup-${unit}.txt"; }; then
            :
        else
            failed=1
        fi
    done
    return "$failed"
}
trap cleanup EXIT
common=(--quiet --wait --pipe --collect --service-type=exec
    --property="User=$user_name" --property="Group=$group_name" --property=UMask=0077
    --property=MemoryMax=2147483648 --property=MemorySwapMax=0 --property=TasksMax=16
    --property=CPUQuota=100% --property=LimitAS=2147483648 --property=LimitFSIZE=262144
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=AmbientCapabilities=
    --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes
    --property=PrivateDevices=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes
    --property=RestrictRealtime=yes --property=KillMode=control-group --property=TimeoutStopSec=2s
    --property=SendSIGKILL=yes --property="ReadWritePaths=$proof" --property="ReadOnlyPaths=$stage"
    --property="WorkingDirectory=$stage/tools")
clean=(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1)
kernel="arome142-constant-kernel-${GITHUB_RUN_ID}.service"
units+=("$kernel")
sudo systemd-run --unit="$kernel" "${common[@]}" --property=RuntimeMaxSec=10s \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/original_pilot_native.py" \
    --kernel-only "$proof/native/kernel-before-constant-get.json" 2>&1 | tee "$proof/kernel-preflight.txt"
printf '0\n' > "$proof/kernel-process-exit.txt"
capture="arome142-constant-capture-${GITHUB_RUN_ID}.service"
units+=("$capture")
# Only this fixed one-URL child can use the network. The parent reserves first.
sudo systemd-run --unit="$capture" "${common[@]}" --property=RuntimeMaxSec=30s \
    "${clean[@]}" GITHUB_RUN_ATTEMPT=1 "$stage/runtime/bin/python" -E -s -B \
    "$stage/tools/constant_original.py" --ledger "$proof/state/day.sqlite" \
    --output "$proof/attempt" --catalogue "$stage/policy/NCALED-catalogue.json" \
    --ticket "$stage/policy/ticket.json" --h000-proof "$stage/policy/h000-native-proof.json" \
    2>&1 | tee "$proof/one-constant-parent.txt"
printf '0\n' > "$proof/capture-process-exit.txt"
sudo install -d -o root -g root -m0555 "$input_stage"
for file in original.grib2 result.json transport.json; do
    sudo install -o root -g root -m0444 "$proof/attempt/$file" "$input_stage/$file"
done
python "$policy/runtime_manifest.py" "$input_stage" "$proof/read-only-original-manifest.json"
native="arome142-constant-native-${GITHUB_RUN_ID}.service"
units+=("$native")
sudo systemd-run --unit="$native" "${common[@]}" --property=RuntimeMaxSec=120s \
    --property="ReadOnlyPaths=$stage $input_stage" \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$stage/runtime/bin/python" -E -s -B "$stage/tools/constant_native.py" \
    --source "$stage/source" --input "$input_stage/original.grib2" \
    --capture "$input_stage/result.json" --transport "$input_stage/transport.json" \
    --manifest "$stage/source-manifest.json" --output "$proof/native/original-mask.json" \
    2>&1 | tee "$proof/native-mask.txt"
printf '0\n' > "$proof/native-process-exit.txt"
python "$policy/runtime_manifest.py" "$input_stage" "$proof/read-only-original-after.json"
python "$policy/runtime_manifest.py" "$stage" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-original-manifest.json" "$proof/read-only-original-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
