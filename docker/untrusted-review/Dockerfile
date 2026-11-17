FROM node:24-trixie-slim
COPY --from=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    gh \
    git \
    jq \
    less \
    openssh-client \
    procps \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest

RUN useradd --create-home --shell /bin/bash reviewer

ENV HOME=/home/reviewer \
  CODEX_HOME=/home/reviewer/.codex \
  CLAUDE_HOME=/home/reviewer/.claude \
  PAPERCLIP_HOME=/home/reviewer/.paperclip-review \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /work

COPY --chown=reviewer:reviewer docker/untrusted-review/bin/review-checkout-pr /usr/local/bin/review-checkout-pr

RUN chmod +x /usr/local/bin/review-checkout-pr \
  && mkdir -p /work \
  && chown -R reviewer:reviewer /work

USER reviewer

EXPOSE 3100 5173

CMD ["bash", "-l"]
