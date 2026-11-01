# Note: Alpine Linux has no official MongoDB package (verified 2026-11-01 via
# `apk search mongodb`, which yields only mongodb-tools and php client extensions).
# Therefore, Ubuntu 24.04 (Noble Numbat) is used as the base for binary and glibc compatibility.

# Stage 1: Official MongoDB 8.0 LTS image
# Digest obtained via `docker buildx imagetools inspect mongo:8.0` on 2026-11-01
# Index Digest: sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142
# Linux AMD64 Manifest: sha256:1d7a2d487c6465ea022474b90b65d6c91bb600b421b65880d8c6e141d6122200
FROM mongo:8.0@sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142 AS source

# Extract only mongod and mongosh binaries and their direct and transitive shared libraries (ldd)
RUN mkdir -p /target/usr/bin /target/usr/lib/x86_64-linux-gnu && \
    cp /usr/bin/mongod /usr/bin/mongosh /target/usr/bin/ && \
    for bin in /usr/bin/mongod /usr/bin/mongosh; do \
      ldd "$bin" | awk '/=>/ { print $3 } /^\t\// { print $1 }' | while read -r lib; do \
        if [ -n "$lib" ] && [ -f "$lib" ] && [ "$(basename "$lib")" != "ld-linux-x86-64.so.2" ]; then \
          cp -L "$lib" /target/usr/lib/x86_64-linux-gnu/; \
        fi; \
      done; \
    done

# Stage 2: Minimal Ubuntu 24.04 runtime (no package caches, no mongo tools like mongodump/mongos)
FROM ubuntu:24.04

# Copy mongod, mongosh, and exact required libraries from Stage 1 into /usr
COPY --from=source /target/usr/bin/ /usr/bin/
COPY --from=source /target/usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/

# Create non-root runner user (UID 1001) and configure dynamic linker
RUN useradd -u 1001 -m -s /bin/bash runner && \
    mkdir -p /box /tmp /data/db /data/configdb && \
    chown -R runner:runner /box /tmp /data/db /data/configdb && \
    chmod 1777 /box /tmp && \
    ldconfig

WORKDIR /box
USER 1001
