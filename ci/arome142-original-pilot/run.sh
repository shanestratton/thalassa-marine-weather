#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = 9f2364baa85ed1ef4b796379789b8140616fa721
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
git -C controls merge-base --is-ancestor "$PILOT_CONTROLLER_SHA" HEAD
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
source_dir="$PWD/source"
controls_dir="$PWD/controls"
policy="$controls_dir/ci/arome142-original-pilot"
proof="$RUNNER_TEMP/arome142-original-pilot-evidence"
runtime="$RUNNER_TEMP/arome142-original-pilot-runtime"
test ! -e "$proof"
test ! -e "$runtime"
mkdir -m700 "$proof" "$proof/state" "$proof/native"
printf '%s\n' "$GITHUB_SHA" > "$proof/control.txt"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$PILOT_CONTROLLER_SHA" > "$proof/controller-source.txt"
python --version > "$proof/python.txt"
node --version > "$proof/node.txt"
cp "$policy/NCALED-catalogue.json" "$proof/catalogue-original.json"
cp "$policy/ticket.json" "$proof/reviewed-one-pilot-ticket.json"
cp "$policy/source-manifest.json" "$proof/native-source-manifest.json"
sha256sum "$source_dir/tools/arome142/native.py" "$source_dir/tools/arome142/catalogue.py" "$source_dir/tools/arome142/native-requirements.lock" > "$proof/native-source-sha256.txt"
test "$(sha256sum "$source_dir/tools/arome142/native-requirements.lock" | cut -d' ' -f1)" = cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64
export AROME_PILOT_CATALOGUE="$policy/NCALED-catalogue.json"
python -m unittest discover -s "$controls_dir/tools/arome142/pilot-tests" -p 'test_*.py' -v 2>&1 | tee "$proof/offline27.txt"
python -m unittest discover -s "$source_dir/tools/arome142" -p 'test_*.py' -v 2>&1 | tee "$proof/unchanged17.txt"
python -m venv "$runtime"
"$runtime/bin/python" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: -r "$source_dir/tools/arome142/native-requirements.lock" 2>&1 | tee "$proof/install.txt"
"$runtime/bin/python" -m pip check 2>&1 | tee "$proof/pip-check.txt"
"$runtime/bin/python" -m pip freeze > "$proof/packages.txt"
user_name="$(id -un)"
group_name="$(id -gn)"
test "$(id -u)" != 0
units=()
cleanup() {
    local failed=0
    for unit in "${units[@]}"; do
        local load
        load="$(sudo systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
        if [[ "$load" != not-found && -n "$load" ]]; then
            sudo systemctl stop "$unit" || failed=1
        fi
        sudo systemctl show "$unit" --property=LoadState --property=ActiveState --property=SubState --property=MainPID > "$proof/cleanup-${unit}.txt" 2>&1 || true
        if grep -qE '^(ActiveState=active|MainPID=[1-9])' "$proof/cleanup-${unit}.txt"; then failed=1; fi
    done
    return "$failed"
}
trap cleanup EXIT
common=(--quiet --wait --pipe --collect --service-type=exec
    --property="User=$user_name" --property="Group=$group_name" --property=UMask=0077
    --property=MemoryMax=2147483648 --property=MemorySwapMax=0 --property=TasksMax=16
    --property=CPUQuota=100% --property=LimitAS=2147483648 --property=LimitFSIZE=4194304
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=AmbientCapabilities=
    --property=ProtectSystem=strict --property=ProtectHome=read-only --property=PrivateTmp=yes
    --property=PrivateDevices=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes
    --property=RestrictRealtime=yes --property=KillMode=control-group --property=TimeoutStopSec=2s
    --property=SendSIGKILL=yes --property="ReadWritePaths=$proof" --property="WorkingDirectory=$source_dir")
clean=(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1)
kernel="arome142-pilot-kernel-${GITHUB_RUN_ID}.service"
units+=("$kernel")
sudo systemd-run --unit="$kernel" "${common[@]}" --property=RuntimeMaxSec=10s \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$runtime/bin/python" -E -s -B "$controls_dir/tools/arome142/original_pilot_native.py" \
    --kernel-only "$proof/native/kernel-before-original-get.json" 2>&1 | tee "$proof/kernel-preflight.txt"
printf '0\n' > "$proof/kernel-process-exit.txt"
capture="arome142-pilot-capture-${GITHUB_RUN_ID}.service"
units+=("$capture")
# This unit alone can use the network, through the controller's fixed one-URL
# child. It has no provider/storage/auth environment or inherited credentials.
sudo systemd-run --unit="$capture" "${common[@]}" --property=RuntimeMaxSec=30s \
    "${clean[@]}" GITHUB_RUN_ATTEMPT=1 "$runtime/bin/python" -E -s -B \
    "$controls_dir/tools/arome142/original_pilot.py" --ledger "$proof/state/day.sqlite" \
    --output "$proof/attempt" --catalogue "$policy/NCALED-catalogue.json" --ticket "$policy/ticket.json" \
    2>&1 | tee "$proof/one-original-parent.txt"
printf '0\n' > "$proof/capture-process-exit.txt"
native="arome142-pilot-native-${GITHUB_RUN_ID}.service"
units+=("$native")
sudo systemd-run --unit="$native" "${common[@]}" --property=RuntimeMaxSec=1200s \
    --property=PrivateNetwork=yes --property=IPAddressDeny=any --property=RestrictAddressFamilies=AF_UNIX \
    "${clean[@]}" "$runtime/bin/python" -E -s -B "$controls_dir/tools/arome142/original_pilot_native.py" \
    --source "$source_dir" --input "$proof/attempt/original.grib2" --capture "$proof/attempt/result.json" \
    --manifest "$policy/source-manifest.json" --output "$proof/native/original-five-fields.json" \
    2>&1 | tee "$proof/native.txt"
printf '0\n' > "$proof/native-process-exit.txt"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
