# 多阶段：前端在镜像里编译，不依赖本机先跑 build:web。
FROM node:24-bookworm-slim AS web

RUN corepack enable

WORKDIR /build

COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY web/ ./
# 用 build:only（vite build），类型检查在 CI 里单独跑。
RUN pnpm build:only

FROM node:24-bookworm-slim

# tar 解 Qoder CLI 的 tgz；ca-certificates 所有上游都是 HTTPS。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY --from=web /build/dist ./web/dist

ENV TZ=Asia/Shanghai

# node 镜像里的 node 用户是 uid 1000，和宿主机普通用户一致，挂进来的 ./data 不用 chown。
USER node

EXPOSE 7801 18801

# 探 /login 而不是 /api/health：后者未认证时 401，会让容器一直 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7801/login').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
