# 网关容器镜像。
#
# 运行时依赖只有两个包（hono + @hono/node-server），源码是 TypeScript、靠 Node
# 原生的类型剥离直接跑，所以没有构建步骤——但**要装依赖**：v1 时这里是
# `node_modules` 都不用的零依赖镜像，v2 引入了 Hono（见 docs/v2 §9）。
#
# 镜像里**不含 data/**：那里是明文凭据、账本和 Qoder CLI，用卷挂进来。
FROM node:24-bookworm-slim

# tar       解 Qoder CLI 的 tgz（cli.ts 调系统 tar，Windows 上才是 tar.exe）
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

# 新版前端产物（v3）。**必须先在本机构建**：`pnpm --dir web build`。
#
# 这里故意用 `COPY` 而不是「找不到就跳过」——`COPY` 在目录不存在时会让构建**当场失败**，
# 而运行时缺产物只会让 `/v3` 回一条 503 提示。构建期失败比运行期静默好：
# 后者会一路部署成功、上线后才发现页面打不开。
#
# F 阶段会改成多阶段构建（`FROM node AS web` + `pnpm build`），届时就不用手工先构建了。
COPY web/dist ./web/dist

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
