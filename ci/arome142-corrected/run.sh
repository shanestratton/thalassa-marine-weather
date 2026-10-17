#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_RUN_ATTEMPT" = 1
test "$PROOF_SOURCE_SHA" = cf21a611c6b22db62449bc1658e7ae8b931476be
test "$CORRECTED_CONTROLLER_SHA" = 04130dba1a83d3d0441aa18afd9b916e42280e03
test "$(git -C source rev-parse HEAD)" = "$PROOF_SOURCE_SHA"
test "$(git -C controls rev-parse HEAD)" = "$GITHUB_SHA"
test "$(git -C controls show HEAD:tools/arome142/corrected_original_native.py | sha256sum | cut -d' ' -f1)" = "91d12b89639a0c7ba9e68ed1acfee80c4ca30381643282224c80566ab71b71c2"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
proof="$RUNNER_TEMP/arome142-corrected-evidence"
stage="$RUNNER_TEMP/arome142-corrected-readonly"
archive="$RUNNER_TEMP/arome142-retained-original.zip"
test -d "$proof"
test ! -e "$stage"
mkdir -m755 "$stage" "$stage/tools" "$stage/source"
mkdir -p "$stage/source/tools/arome142"
printf '%s\n' "$PROOF_SOURCE_SHA" > "$proof/source.txt"
printf '%s\n' "$CORRECTED_CONTROLLER_SHA" > "$proof/corrected-controller.txt"
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
cp controls/tools/arome142/corrected_original_native.py "$stage/tools/"
cp controls/tools/arome142/original_pilot_native.py "$stage/tools/"
python - "$stage/source-manifest.json" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"source":"cf21a611c6b22db62449bc1658e7ae8b931476be","files":{"native.py":"8a17f8650a4bc95ce9ec3562dbf961e8a7bedd82e4c915f75a77c726ead76c69","catalogue.py":"d6f0aad3ab1a5dce00a6be38e51071753c49c9f9564966ed527c74a62839743d","native-requirements.lock":"cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64"}},sort_keys=True,indent=2)+"\n")
PY
python -B -m unittest discover -s controls/tools/arome142/corrected-tests -p 'test_*.py' -v 2>&1 | tee "$proof/controller15.txt"
python -m unittest discover -s source/tools/arome142 -p 'test_*.py' -v 2>&1 | tee "$proof/source18.txt"
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
unit="arome142-corrected-retained-${GITHUB_RUN_ID}.service"
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
    "$stage/runtime/bin/python" -E -s -B "$stage/tools/corrected_original_native.py" \
    --source "$stage/source" --input "$stage/input/attempt/original.grib2" \
    --capture "$stage/input/attempt/result.json" --manifest "$stage/source-manifest.json" \
    --output "$proof/corrected-native-original.json" 2>&1 | tee "$proof/corrected-native.txt"
printf '0\n' > "$proof/native-process-exit.txt"
python controls/ci/arome142-scalar/runtime_manifest.py "$stage" "$proof/read-only-runtime-after.json"
cmp "$proof/read-only-runtime-manifest.json" "$proof/read-only-runtime-after.json"
test -z "$(git -C source status --porcelain)"
test -z "$(git -C controls status --porcelain)"
