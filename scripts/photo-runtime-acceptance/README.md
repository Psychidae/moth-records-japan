# Synthetic isolated photo runtime acceptance

This standalone job proves only the existing Linux CLI can decode, strip metadata,
resize and scan an original synthetic JPEG under the current isolation guard.
It does not use an original user photo, connect DB/R2, register a photo, enable
intake, publish an image or establish production executor acceptance.

The dedicated workflow uses `ubuntu-24.04`, read-only contents permission, pinned
actions and no environment or service secrets. A fresh official signed ClamAV
database is downloaded in the separate image-build stage. The scan itself has no
network. Its signature timestamp must be strictly less than 48 hours old.

Run the dependency-free source tests with Node 24:

```sh
node --experimental-strip-types --test scripts/photo-runtime-acceptance/selftest.ts
```

On a disposable Linux Docker runner with sudo, from the repository root:

```sh
bash pipelines/process-photo/container/build.sh /tmp/photo-runtime-build
bash scripts/photo-runtime-acceptance/run.sh /tmp/photo-runtime-build/image-id.txt generated/photo-runtime-acceptance
```

Both output directories must be absent. The image recipe supplies its frozen
runtime dependencies and source allowlist without installing the root workspace.
The acceptance launcher accepts only the locally built `sha256:` image ID. This
is a Docker content ID, not a registry manifest digest. The production image
allowlist and executor contract are unchanged and cannot consume this receipt.

The fixture is a deterministic 2400×1600 grayscale baseline JPEG generated with
Node built-ins, including invented EXIF Orientation=1 and a comment. The actual
CLI creates 2048/1024/500/240 variants. A separate host parser checks exact file
names, bounded nonsymlink regular files, manifest fields, hashes, dimensions,
aspect ratio, stripping and real regeneration. The image probe records exact
source bytes, engine versions, signed-database hashes/verification and an actual
harmless ClamAV EICAR self-test. It uses the same namespace restrictions.

The source and root filesystem are read-only, UID/GID are 65532, all Linux
capabilities are dropped, no-new-privileges is set, and only loopback is present.
The daemon must report its builtin seccomp profile; the live probe must have
Seccomp mode 2. Actual scratch permissions are checked as root-owned 1777 and
the empty output directory as UID/GID 65532-owned 0700, without symlinks.
Memory is 1 GiB, CPU is 1, PIDs are 64, scratch tmpfs is 256 MiB and output tmpfs
is 64 MiB. The existing memory limit is deliberately not relaxed; an AV database
that exceeds it must fail acceptance. Docker configuration, exit status and OOM
state are independently checked. Docker logging is disabled and captured files
are size-capped. Processing is capped at 480 seconds; named containers and mounts
are cleaned on success, error or cancellation. The final receipt is created only
after daemon-confirmed container removal, unmount and job-directory removal.

Only JSON execution facts and bounded command logs are retained for seven days.
No source JPEG, derived JPEG or signature database is uploaded. Exact recipe,
base image, snapshot/package, source and signature hashes support replay of the
same inputs; refreshed signatures intentionally produce a new image identity.
No bit-identical rebuild guarantee is claimed without comparing rebuilt images.
A later exact replay also requires retaining the original signed CVD bytes or
the image itself. This first job deliberately uploads neither, so hashes alone
cannot restore a database version after the official download changes. No
registry image is published; choosing archival storage and retention is separate.
A green source test or image build alone is not runtime acceptance: only a
successful `acceptance.json` plus its CI run demonstrates actual processing.
