FROM docker.io/cloudflare/sandbox:0.7.0
COPY --from=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
