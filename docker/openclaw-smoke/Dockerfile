FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 8787

CMD ["bun", "/app/server.mjs"]
