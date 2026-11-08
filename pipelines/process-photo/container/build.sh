#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 || "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Usage (Linux amd64 Docker host): bash build.sh NEW_OUTPUT_DIRECTORY [PINNED_SIGNATURE_DIRECTORY]' >&2
  exit 1
fi
recipe="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository="$(cd -- "$recipe/../../.." && pwd -P)"
output="$1"
[[ ! -e "$output" ]] || { echo 'Output must not exist' >&2; exit 1; }
mkdir -m 700 -- "$output"
output="$(cd -- "$output" && pwd -P)"
timeout --kill-after=10s 30s docker version > "$output/docker-version.txt"
timeout --kill-after=10s 30s docker buildx version > "$output/buildx-version.txt"
nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
tag="moth-photo-build-local:$nonce"
engine_tag="${tag}-engines"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if ! ids="$(timeout --kill-after=10s 30s docker container ls -aq --filter "label=moth.photo.build=$nonce")"; then
    echo 'Build container cleanup is unconfirmed; inspect Docker host before retry.' >&2
    exit 1
  fi
  for cid in $ids; do
    if ! timeout --kill-after=10s 30s docker container rm --force "$cid" >/dev/null; then
      echo 'Build container stop/removal is unconfirmed.' >&2
      exit 1
    fi
  done
  if ! remaining="$(timeout --kill-after=10s 30s docker container ls -aq --filter "label=moth.photo.build=$nonce")" || [[ -n "$remaining" ]]; then
    echo 'Build container cleanup verification failed.' >&2
    exit 1
  fi
  printf '{"build_containers_remaining":0}\n' > "$output/build-cleanup.json"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Only the allowlisted Dockerfile context is sent; never the root workspace,
# private photographs, credentials, generated assets, or unrelated code.
timeout --kill-after=30s 40m docker buildx build --load --platform linux/amd64 --target signature-tools \
  --file "$recipe/Dockerfile" --tag "$engine_tag" "$repository"
timeout --kill-after=10s 30s docker image inspect --format '{{.Id}}' "$engine_tag" > "$output/engine-image-id.txt"
engine="$(cat "$output/engine-image-id.txt")"
mkdir -m 700 -- "$output/signatures"
if [[ $# == 2 ]]; then
  # Explicit replay only: never silently refresh different bytes during a build.
  for name in main.cvd daily.cvd bytecode.cvd signature-lock.json; do
    [[ -f "$2/$name" && ! -L "$2/$name" ]] || { echo "Missing pinned signature file: $name" >&2; exit 1; }
    cp -- "$2/$name" "$output/signatures/$name"
  done
else
  # This separate downloader gets no photo/source/credential mounts. Freshclam
  # verifies official signatures. Only its pinned output enters the processor.
  timeout --kill-after=20s 20m docker run --rm --log-driver none --name "moth-photo-build-$nonce-refresh" --label "moth.photo.build=$nonce" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --pids-limit 64 --memory 3g --cpus 1 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /download:rw,nosuid,nodev,noexec,size=1g,mode=1777 \
    --mount "type=bind,src=$output/signatures,dst=/signatures" \
    --entrypoint node "$engine" /opt/recipe/signatures.mjs refresh /signatures
fi
timeout --kill-after=20s 5m docker run --rm --log-driver none --name "moth-photo-build-$nonce-verify" --label "moth.photo.build=$nonce" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --pids-limit 64 --memory 2g \
  --mount "type=bind,src=$output/signatures,dst=/signatures,readonly" \
  --entrypoint node "$engine" /opt/recipe/signatures.mjs verify /signatures
timeout --kill-after=30s 40m docker buildx build --load --platform linux/amd64 --target runtime \
  --file "$recipe/Dockerfile" --build-context "photo-signatures=$output/signatures" \
  --tag "$tag" "$repository"
timeout --kill-after=10s 30s docker image inspect --format '{{.Id}}' "$tag" > "$output/image-id.txt"
image="$(cat "$output/image-id.txt")"
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Local immutable image ID missing' >&2; exit 1; }
timeout --kill-after=10s 30s docker image inspect "$image" > "$output/image-inspect.json"
timeout --kill-after=10s 60s docker run --rm --log-driver none --name "moth-photo-build-$nonce-provenance" --label "moth.photo.build=$nonce" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 65532:65532 --pids-limit 64 --memory 128m --entrypoint node "$image" \
  -e 'process.stdout.write(require("node:fs").readFileSync("/usr/share/moth-photo-runtime/provenance.json"))' > "$output/provenance.json"
printf 'Built local image %s. Independent Linux acceptance is still required.\n' "$image"
