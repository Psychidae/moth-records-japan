# Isolated photo runtime

This is the build recipe, **not a qualified production image**. At source creation
on 2026-11-08 it has not been built or run remotely. The Mac has no Docker runtime.
Only a successful independent Linux synthetic-photo acceptance run can qualify
the resulting image. Do not interpret unit tests, the recipe, or image creation
alone as successful processing. No photo intake, DB, R2 or public image service is
enabled by these files.

## Exact inputs

`inputs.json` records inputs verified from official registries and Debian snapshot
metadata on 2026-11-08:

- Linux amd64 Node **24.22.2**, official image manifest pinned by SHA-256, not a
  floating tag. The checked multi-platform index and original tag are informational.
- Debian bookworm and bookworm-security snapshot **20261108T000000Z**.
- ClamAV **1.4.6+dfsg-0+deb12u1**; libvips **8.14.1-3+deb12u3**. Principal package
  versions and downloaded `.deb` SHA-256 values are checked during the build.
- Zod **4.6.7**: isolated `package-lock.json` matches the existing repository lock's
  SHA-512 integrity. `npm ci --ignore-scripts` installs no dev dependencies.
- Exactly five existing processing/schema source files, each hashed in provenance.
  The root workspace package manifest/lock and other application code are not used.
- Official signed ClamAV `main.cvd`, `daily.cvd`, `bytecode.cvd`. Each refresh first
  produces an immutable `signature-lock.json`, containing the SHA-256, byte length,
  database build time and successful `sigtool --info` verification output.

The snapshot's archive signatures and package hashes are still checked. Only the
historical metadata expiration is disabled. TLS validation is never disabled:
BuildKit first fetches a SHA-pinned Debian CA-data archive over HTTPS and extracts
the public trust bundle before APT connects. No private certificate or key is used.

`inventory.mjs` additionally records every installed builder package/version/arch
and every downloaded archive hash. The base digest covers inherited packages.
`runtime-files.json` records every shipped regular file's content hash and every
symlink target (excluding itself and provenance). It includes installed npm files,
copied shared libraries/modules, executables, licenses and source. This is an exact
build inventory, not a claim of an independently audited SPDX/CycloneDX SBOM.

## Build on an authorized Docker-capable Linux amd64 host

Requires Docker Engine and a recent BuildKit/buildx supporting named build contexts,
`ADD --checksum` and `RUN --network=none`. It does not install Docker, change daemon
settings, create credentials or publish to a registry. Do not run it on the Mac.

```sh
bash pipelines/process-photo/container/build.sh /tmp/moth-photo-runtime-build
```

The output directory must not already exist. The command:

1. Builds the pinned engine/downloader stage from the narrow Dockerfile-specific
   context allowlist. Private photos, `.env`, Git data, generated assets and the
   rest of the monorepo are excluded.
2. Runs a separate networked FreshClam downloader with no photos, source mounts,
   credentials or host environment variables. Official signatures are verified.
   Download staging is a 1 GiB tmpfs (3 GiB memory limit); only the three verified
   CVD files, each bounded to 512 MiB, are copied to its own output mount. CDN failures
   fail the build; there is no unofficial mirror, unsigned or synthetic fallback.
3. Rechecks the CVD signatures and hashes with networking disabled.
4. Assembles a scratch runtime with networking disabled, rechecks the pins and
   produces a local content-addressed image. It does not pull during processing.
5. Writes `image-id.txt`, `engine-image-id.txt`, `image-inspect.json`,
   `provenance.json`, `build-cleanup.json`, Docker/buildx versions, and the pinned
   `signatures/` bundle. Helper containers have bounded durations, disabled daemon
   logging and unique ownership labels. Cleanup stops/removes them and verifies
   none remain; an uncertain stop is a failure, not a successful build.

The separate CI acceptance launcher consumes `image-id.txt`. A local image ID is
allowed only for this credential-free synthetic acceptance harness. The production
executor still requires its existing reviewed `ghcr.io/psychidae/moth-photo-processor@sha256:...`
repository digest, preloaded image and independent host/DB/journal configuration.
This recipe does not weaken or modify that contract.

## Refresh and reproduce

Freshness is intentionally not reproducible indefinitely: the processor rejects
an official daily database older than **48 hours**, including a perfectly pinned
old image. For each authorized release, run a new refresh, keep its complete signed
database bundle and lock with the acceptance evidence, rebuild and requalify the
new image. A digest-pinned runtime never updates itself and has no network.

To replay the exact retained signature bytes while still fresh:

```sh
bash pipelines/process-photo/container/build.sh /tmp/moth-photo-runtime-replay \
  /path/to/previous-build/signatures
```

Replay never silently downloads different signature bytes. An old or altered
bundle fails closed. No date spoofing, disabled AV, custom dummy signature, reduced
database set or relaxed production memory/network/identity guard is used. Engine
or snapshot updates require a deliberate new pin review and acceptance run.

File timestamps are normalized to the signed daily database build time. Docker
exporter/config metadata may vary, so this promises reproducible pinned source and
runtime file contents, not byte-identical OCI archives from different BuildKit
versions. Preserve the recorded local image ID and complete evidence. Retain or
export the resulting OCI image separately before CI cleanup if it will be used
later. The temporary local image tag is never a production trust anchor.

## Runtime boundary and contents

- Scratch final stage inherits no Node `NODE_VERSION`/`YARN_VERSION`, entrypoint,
  shell or volume. Its only configured environment variables match the existing
  `PHOTO_CHILD_ENVIRONMENT`; Docker may additionally provide `HOSTNAME`.
- UID/GID `65532:65532`, working directory `/work`; exactly the existing CLI/source
  and Zod. Runtime executables: Node, clamscan, vipsthumbnail, sigtool.
- Debian shared libraries and loadable modules needed by the installed decoders,
  ELF loader, public timezone/OS data and package copyright notices are retained.
  No shell, Python executable, npm, apt, compiler, freshclam updater, network client
  utility, service daemon, authentication material or repository `.git` is shipped.
- No photos, DB/R2/Cloudflare bindings, service keys, pending jobs or user data.
- Signature directory `/var/lib/clamav` is baked in and read-only at execution.
- Read-only facts: `/usr/share/moth-photo-runtime/provenance.json`, `inputs.json`,
  `package-lock.json`, `debian-inventory.json` and `runtime-files.json`.
- Provenance format `photo-runtime-provenance-v1`; `source` is
  `[{path,bytes,sha256}]`; `signatures` contains `daily_built_at` and
  `files:[{name,bytes,sha256,built_at,info}]`.

The host must still supply the full existing sandbox: network none, read-only
root/input, empty private owned output, cap-drop ALL, no-new-privileges, pids64,
memory1GiB, CPU1, noexec tmpfs and fixed argv/environment. A real scan exceeding
those limits is a qualification failure to investigate, not a reason to silently
weaken them. Full official ClamAV database memory use needs real-run verification.

## Verification status

Verified locally: official base manifest/config, snapshot package metadata and
principal archive pins; JavaScript/Bash syntax and scoped static checks. No Docker
build, FreshClam download, ClamAV scan, libvips processing or production executor
run has yet occurred when this recipe was written. CI evidence, once available,
must report its exact image/source/signature identities, isolation facts, AV
negative control and four decoded/re-encoded output identities independently.
