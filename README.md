# Axon OTC

基于 Node.js + Express 的 AXON OTC 网页端，支持：

- 浏览市场订单
- 浏览最近成交记录
- 连接浏览器钱包查看余额
- 创建卖单
- 自动购买
- 申请取消 / 确认取消 / 中止取消
- 发起争议

## 目录结构

```text
axon-otc/
├── public/             # 前端静态页面
├── server.js           # 后端入口
├── package.json        # 项目依赖与脚本
├── deploy.sh           # 一键部署脚本
└── README.md
```

## 运行环境

- Node.js 18+
- npm 9+
- Linux / macOS（Windows 也可手动执行同等命令）

## 安装依赖

```bash
npm install
```

## 本地启动

```bash
npm start
```

默认监听：

- `http://127.0.0.1:8080`

## 开发模式

```bash
npm run dev
```

## 一键部署

首次部署：

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会自动：

1. 安装依赖
2. 清理旧的 `8080` 端口进程
3. 使用 `nohup` 启动服务
4. 输出日志文件位置
5. 检查 `8080` 监听状态

## 环境变量

可选环境变量：

- `PORT`：服务端口，默认 `8080`
- `KEEPER_HTTP_TIMEOUT`：Keeper HTTP 超时时间（秒），默认脚本里使用 `12`

示例：

```bash
PORT=8080 KEEPER_HTTP_TIMEOUT=12 npm start
```

## 日志

部署脚本默认输出到：

```bash
/tmp/axon-otc-8080.log
```

查看日志：

```bash
tail -f /tmp/axon-otc-8080.log
```

## 停止服务

```bash
lsof -ti tcp:8080 | xargs kill -9
```

## 打包上传 GitHub 建议

上传前建议不要把这些内容打进去：

- `node_modules/`
- 运行日志
- 临时压缩包

项目已经提供 `.gitignore`，可直接初始化 Git：

```bash
git init
git add .
git commit -m "init axon otc project"
```

## 说明

当前项目已经清理掉一部分旧的、未使用的前端购买流程残留，以及未使用的依赖，保留的是当前可运行版本。
