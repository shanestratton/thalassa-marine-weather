#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = 9f2364baa85ed1ef4b796379789b8140616fa721
test "$SCALAR_CONTROLLER_SHA" = 0c33f8ac3e1a87d0cd122061e09b89c99e8b8d00
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$SCALAR_CONTROLLER_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
proof="$RUNNER_TEMP/arome142-scalar-evidence"
stage="$RUNNER_TEMP/arome142-scalar-readonly"
archive="$RUNNER_TEMP/arome142-retained-original.zip"
test -d "$proof"
test ! -e "$stage"
mkdir -m755 "$stage" "$stage/tools" "$stage/source"
mkdir -p "$stage/source/tools/arome142"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$SCALAR_CONTROLLER_SHA" > "$proof/scalar-controller.txt"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
python_path="$(command -v python)"
timeout --signal=TERM --kill-after=2s 15s sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$python_path" -E -s -B "$PWD/controls/ci/arome142-scalar/runtime_manifest_tests.py" 2>&1 | tee "$proof/posix-link-fixtures10.txt"
python controls/tools/arome142/scalar_artifact.py --archive "$archive" --output "$stage/input"
cp "$stage/input/verified-retained-artifact.json" "$proof/retained-artifact.json"
cp "$stage/input/native/kernel-before-original-get.json" "$proof/original-kernel-before-get.json"
cp "$stage/input/native.txt" "$proof/original-native-refusal.txt"
for file in "$stage/input"/cleanup-*.txt; do cp "$file" "$proof/original-$(basename "$file")"; done
for file in native.py catalogue.py native-requirements.lock; do
    cp "source/tools/arome142/$file" "$stage/source/tools/arome142/$file"
done
cp controls/tools/arome142/scalar_inspection.py "$stage/tools/"
cp controls/tools/arome142/original_pilot_native.py "$stage/tools/"
cp source/tools/arome142/catalogue.py "$stage/tools/"
python -m unittest discover -s controls/tools/arome142/scalar-tests -p 'test_*.py' -v 2>&1 | tee "$proof/offline14.txt"
python -m unittest discover -s source/tools/arome142 -p 'test_*.py' -v 2>&1 | tee "$proof/unchanged17.txt"
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
python controls/ci/arome142-scalar/runtime_manifest.py "$stage" "$proof/read-only-runtime-manifest.json"
user_name="$(id -un)"
group_name="$(id -gn)"
test "$(id -u)" != 0
unit="arome142-scalar-retained-${GITHUB_RUN_ID}.service"
cleanup() {
    local load failed=0
    load="$(sudo systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
    if [[ "$load" != not-found && -n "$load" ]]; then sudo systemctl stop "$unit" || failed=1; fi
    sudo systemctl show "$unit" --property=LoadState --property=ActiveState --property=SubState --property=MainPID > "$proof/cleanup.txt" 2>&1 || true
    if grep -q '^LoadState=not-found$' "$proof/cleanup.txt" && grep -q '^MainPID=0$' "$proof/cleanup.txt"; then
        :
    elif grep -q '^ActiveState=inactive$' "$proof/cleanup.txt" && grep -q '^MainPID=0$' "$proof/cleanup.txt"; then
        :
    else
        failed=1
    fi
    return "$failed"
}
trap cleanup EXIT
sudo systemd-run --unit="$unit" --quiet --wait --pipe --collect --service-type=exec \
    --property="User=$user_name" --property="Group=$group_name" --property=UMask=0077 \
    --property=MemoryMax=2147483648 --property=MemorySwapMax=0 --property=TasksMax=16 \
    --property=CPUQuota=100% --property=LimitAS=2147483648 --property=LimitFSIZE=262144 \
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=AmbientCapabilities= \
    --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes \
    --property=PrivateDevices=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes \
    --property=RestrictRealtime=yes --property=KillMode=control-group --property=TimeoutStopSec=2s \
    --property=SendSIGKILL=yes --property=RuntimeMaxSec=120s --property="ReadWritePaths=$proof" \
    --property="ReadOnlyPaths=$stage" --property="WorkingDirectory=$stage/tools" \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 \
    "$stage/runtime/bin/python" -E -s -B "$stage/tools/scalar_inspection.py" \
    --source "$stage/source" --input "$stage/input/attempt/original.grib2" \
    --output "$proof/original-scalar-headers.json" 2>&1 | tee "$proof/scalar-native.txt"
printf '0\n' > "$proof/native-process-exit.txt"
python controls/ci/arome142-scalar/runtime_manifest.py "$stage" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
