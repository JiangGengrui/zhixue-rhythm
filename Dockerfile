# 智学节律 · 云托管容器镜像
# 构建阶段：安装依赖 + 打包前端 + 生成服务端引擎
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段：只需要 dist + server，运行时零第三方依赖（node:sqlite 为内置模块）
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=80 \
    DB_FILE=/app/data/zhixue.db
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
RUN mkdir -p /app/data
EXPOSE 80
CMD ["node", "server/index.mjs"]
