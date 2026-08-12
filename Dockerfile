# Settler worker: the only process that can call settle() on the Arena contract.
# Runs the same code as `pnpm worker:settler`, in a persistent loop.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY workers ./workers

CMD ["pnpm", "worker:settler"]