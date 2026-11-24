# 网关容器镜像。**多阶段构建**：前端在镜像里自己编译，不依赖本机先跑 build:web。
#
# 为什么改成多阶段（2026-11-25）：原先要求「本机先 pnpm --dir web build」再 docker build，
# 因为 `COPY web/dist` 找不到就当场失败。这在开发机上没问题，但 CI 里多一步就要多维护
# 一份脚本，而且忘了跑就构建失败。现在 `docker build .` 一步到位。
#
# 运行时依赖只有两个包（hono + @hono/node-server），源码是 TypeScript、靠 Node 原生的
# 类型剥离直接跑，所以运行时镜像里没有构建步骤。
#
# 镜像里**不含 data/**：那里是明文凭据和账本，用卷挂进来。

# ---------------------------------------------------------------- 前端构建
FROM node:24-bookworm-slim AS web

# corepack 是 node 官方镜像自带的，用 packageManager 字段里声明的那个 pnpm 版本，
# 不需要在 CI 里额外装 pnpm，也不会因为版本漂移导致 lock 文件对不上。
RUN corepack enable

WORKDIR /build

# 先只拷 lock + manifest：改源码不会让依赖层失效。
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY web/ ./
# 用 build:only（vite build）而不是 build（vue-tsc && vite build）：
# 类型检查在 CI 的独立 job 里跑（`npm run check:web`），这里只要产物。
# 放进镜像里跑两遍类型检查只是拖慢构建。
RUN pnpm build:only

# ---------------------------------------------------------------- 运行时
FROM node:24-bookworm-slim

# tar              解 Qoder CLI 的 tgz（cli.ts 调系统 tar，Windows 上才是 tar.exe）
# ca-certificates  所有上游都是 HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖再拷源码：改代码不会让依赖层失效。
# `--omit=dev` 跳过 typescript / @types/node——镜像里只需要能跑。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 前端产物从上一阶段拿。**不要**改成 `COPY web/dist`：那个目录在本机是构建产物、
# 被 gitignore，CI 里不存在。
COPY --from=web /build/dist ./web/dist

# 签到窗口按北京时间开，容器时区跟着定，日志时间戳才对得上
ENV TZ=Asia/Shanghai

# 官方 node 镜像里的 node 用户就是 uid 1000，和宿主机上的普通用户一致，
# 挂进来的 ./data 不需要 chown 就能写。
USER node

EXPOSE 7801 18801

# 用 node 自己探活，不为一个 healthcheck 往镜像里装 curl。
# 探 /login 而不是 /health：加了登录之后 /health 未认证时回 401，会让容器一直
# unhealthy；登录页是公开的，服务活着就一定是 200。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7801/login').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
