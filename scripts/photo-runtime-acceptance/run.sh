#!/usr/bin/env bash
# Standalone SYNTHETIC acceptance only. This is not the production executor.
set -euo pipefail
umask 077
# Bound every captured command stream even if an image executable misbehaves.
ulimit -f 2048
[[ $# == 2 && "$(uname -s)" == Linux ]] || { echo 'Linux, image-ID file and empty evidence directory required.' >&2; exit 1; }
image="$(cat -- "$1")"
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
evidence="$2"
[[ ! -e "$evidence" ]] || { echo 'Evidence directory must not already exist.' >&2; exit 1; }
mkdir -p -- "$evidence"
evidence="$(realpath -- "$evidence")"
root="/tmp/moth-photo-job-$(node -e "process.stdout.write(require('node:crypto').randomUUID().replaceAll('-',''))")"
name="moth-photo-acceptance-${root##*-}"
mkdir -m 700 -- "$root"
mounted=false
cleaned=false
remove_container() {
  local target="$1" ids
  ids="$(timeout --kill-after=5s 15s docker container ls --all --no-trunc --filter "name=^/${target}$" --format '{{.ID}}')" || return 1
  if [[ -n "$ids" ]]; then
    [[ "$ids" =~ ^[a-f0-9]{64}$ ]] || return 1
    timeout --kill-after=5s 30s docker rm -f "$ids" >/dev/null || return 1
  fi
  ids="$(timeout --kill-after=5s 15s docker container ls --all --no-trunc --filter "name=^/${target}$" --format '{{.ID}}')" || return 1
  [[ -z "$ids" ]]
}
cleanup() {
  [[ "$cleaned" == false ]] || return 0
  local failed=0
  remove_container "$name" || failed=1
  remove_container "${name}-probe" || failed=1
  # Keep the bounded output mounted if any container's absence is uncertain.
  if [[ "$failed" != 0 ]]; then echo 'Container cleanup not confirmed; no acceptance receipt.' >&2; return 1; fi
  if [[ "$mounted" == true ]] || mountpoint -q -- "$root/derived"; then
    timeout --kill-after=5s 15s sudo umount -- "$root/derived" || return 1
    mounted=false
  fi
  if mountpoint -q -- "$root/derived"; then return 1; fi
  timeout --kill-after=5s 15s sudo rm -rf -- "$root" || return 1
  [[ ! -e "$root" ]] || return 1
  cleaned=true
}
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if ! cleanup; then status=1; fi
  if [[ "$status" != 0 ]]; then rm -f -- "$evidence/acceptance-candidate.json"; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read -r source_sha source_bytes < <(node --experimental-strip-types scripts/photo-runtime-acceptance/fixture.ts "$root")
[[ "$source_sha" =~ ^[a-f0-9]{64}$ && "$source_bytes" =~ ^[1-9][0-9]{0,7}$ && "$source_bytes" -le 10485760 ]]
sudo install -d -m 700 -o 65532 -g 65532 "$root/derived"
# Output is disk-bounded independently of a successful/failed decoder.
sudo mount -t tmpfs -o size=64m,uid=65532,gid=65532,mode=0700,nosuid,nodev,noexec tmpfs "$root/derived"
mounted=true
flags=(--network none --read-only --cap-drop ALL --security-opt no-new-privileges
  --log-driver none
  --pids-limit 64 --memory 1g --cpus 1 --user 65532:65532
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m
  --env PATH=/usr/local/bin:/usr/bin:/bin --env LANG=C.UTF-8
  --env HOME=/tmp/empty --env TMPDIR=/tmp/work
  --env VIPS_CONCURRENCY=1 --env VIPS_DISC_THRESHOLD=64m
  --mount "type=bind,src=$root/input.jpg,dst=/in/input.jpg,readonly"
  --mount "type=bind,src=$root/derived,dst=/out" --workdir /work)
timeout --kill-after=5s 15s docker image inspect "$image" > "$evidence/image-inspect.json"
# No pull/tag/registry lookup, secrets, service connection or external input here.
timeout --signal=TERM --kill-after=10s 180s docker run --rm --name "${name}-probe" "${flags[@]}" "$image" \
  node --experimental-strip-types --input-type=module --eval "$(cat scripts/photo-runtime-acceptance/probe.mjs)" \
  > "$evidence/runtime-probe.json" 2> "$evidence/probe-stderr.log"
timeout --kill-after=5s 30s docker create --name "$name" "${flags[@]}" "$image" \
  node --experimental-strip-types /work/pipelines/process-photo/src/cli.ts \
  /in/input.jpg /out "$source_sha" "$source_bytes" > /dev/null
timeout --kill-after=5s 15s docker inspect "$name" > "$evidence/container-before.json"
node --experimental-strip-types scripts/photo-runtime-acceptance/verify.ts container "$root" "$evidence" "$image"
set +e
timeout --signal=TERM --kill-after=10s 480s docker start --attach "$name" > "$evidence/processing.log" 2>&1
run_status=$?
set -e
timeout --kill-after=5s 15s docker inspect "$name" > "$evidence/container-after.json"
[[ "$run_status" == 0 ]] || { echo "Isolated CLI failed (exit $run_status); no acceptance receipt created." >&2; exit "$run_status"; }
# Fixed files only, no recursive ownership traversal over decoder-controlled paths.
sudo chown -h "$(id -u):$(id -g)" "$root/derived" "$root/derived/2048.jpg" "$root/derived/1024.jpg" "$root/derived/500.jpg" "$root/derived/240.jpg" "$root/derived/manifest.json"
node --experimental-strip-types scripts/photo-runtime-acceptance/verify.ts result "$root" "$evidence" "$image"
cleanup
node --input-type=module - "$evidence" <<'JS'
import {readFile,writeFile,unlink} from 'node:fs/promises';
const root=process.argv[2],candidate=root+'/acceptance-candidate.json';
const receipt=JSON.parse(await readFile(candidate,'utf8'));
receipt.cleanup={containers_removed:true,tmpfs_unmounted:true,job_directory_removed:true};
await writeFile(root+'/acceptance.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
await unlink(candidate);
JS
echo 'Synthetic runtime acceptance and bounded cleanup confirmed. Production intake remains disabled.'
# No input/derived images are uploaded. Only synthetic hashes and execution facts remain.
