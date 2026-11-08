FROM --platform=linux/amd64 docker.io/library/node@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4 AS signature-tools

# The slim base need not contain CA certificates. Bootstrap only trust data
# from a verified Debian archive, using BuildKit HTTPS and the pinned checksum.
ADD --checksum=sha256:0d5f444f594e48c1e16a41d8fc628a09b24c658916a1274025c2330f2a802bed https://snapshot.debian.org/archive/debian/20261108T000000Z/pool/main/c/ca-certificates/ca-certificates_20230311+deb12u1_all.deb /opt/bootstrap-ca.deb
RUN dpkg-deb -x /opt/bootstrap-ca.deb /opt/bootstrap-ca \
 && mkdir -p /etc/ssl/certs \
 && cat /opt/bootstrap-ca/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt

# Snapshot validity expiry is disabled only for immutable historical metadata.
# Debian archive signatures and all package content hashes remain mandatory.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* /etc/apt/apt.conf.d/docker-clean \
 && printf '%s\n' \
 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261108T000000Z bookworm main' \
 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261108T000000Z bookworm-security main' > /etc/apt/sources.list \
 && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
    ca-certificates=20230311+deb12u1 clamav=1.4.6+dfsg-0+deb12u1 clamav-freshclam=1.4.6+dfsg-0+deb12u1 \
    libclamav12=1.4.6+dfsg-0+deb12u1 libvips-tools=8.14.1-3+deb12u3 libvips42=8.14.1-3+deb12u3

COPY pipelines/process-photo/container/ /opt/recipe/
RUN node /opt/recipe/inventory.mjs
WORKDIR /opt/npm
COPY pipelines/process-photo/container/package.json pipelines/process-photo/container/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM signature-tools AS assembled
COPY pipelines/process-photo/src/cli.ts pipelines/process-photo/src/index.ts pipelines/process-photo/src/artifacts.ts pipelines/process-photo/src/sandbox-plan.ts /opt/source/pipelines/process-photo/src/
COPY packages/schema/photo-processing.ts /opt/source/packages/schema/photo-processing.ts
# Named context is created independently, signature-verified, and hash-locked.
# No network is used when assembling the final image.
COPY --from=photo-signatures / /opt/signatures/
RUN --network=none node /opt/recipe/assemble.mjs

# Start with an empty image config, not inherited Node ENV/entrypoint/volumes.
FROM scratch AS runtime
COPY --from=assembled /runtime/ /
LABEL org.opencontainers.image.title="Moth isolated photo processor" \
      org.opencontainers.image.description="Offline JPEG decoding and ClamAV scanning; qualification requires real Linux acceptance"
ENV PATH="/usr/local/bin:/usr/bin:/bin" LANG="C.UTF-8" HOME="/tmp/empty" TMPDIR="/tmp/work" VIPS_CONCURRENCY="1" VIPS_DISC_THRESHOLD="64m"
USER 65532:65532
WORKDIR /work
ENTRYPOINT []
CMD ["node", "--experimental-strip-types", "/work/pipelines/process-photo/src/cli.ts"]
