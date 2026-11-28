# DeepReplica

**目标：** 在浏览器里复刻接近 [DeepSeek Chat / chat-demo](https://cdn.deepseek.com/chat-demo/) 的对话体验，同时坚持 **BYOK（自带 Key）+ 数据只留在本机**——没有应用后端代持密钥，对话与设置写进 IndexedDB，Key 经 AES-GCM 加密后再落盘。

本项目面向「想用官方能力、又不想把密钥和历史交给第三方托管」的场景：协议与产品能力对齐 DeepSeek 开放接口与官方 demo，产品形态是可自托管的静态前端。

## 做什么 / 不做什么

| 做 | 不做 |
|----|------|
| 流式对话、深度思考、Web 搜索 / 读链与引用 | 代管用户的 API Key 或云端会话 |
| Markdown、公式、代码高亮、Mermaid、复制 | 替代官方平台账单与账号体系 |
| 多会话、重命名、编辑 / 重生成 / 续写、分支 | 强依赖自建业务服务器 |
| 本机用量账本 + 开放平台余额查询 | 把隐私数据默认同步到云端 |

功能对齐进度见 [`docs/roadmap-chat-demo-parity.md`](docs/roadmap-chat-demo-parity.md)。

## 技术栈（摘要）

- Vite + TypeScript 静态 SPA
- Chat Completions（含 thinking、tools、`title`、beta `prefix`）
- IndexedDB：会话、设置、加密 vault、用量

## 本地运行

```bash
npm install
npm run dev
```

在设置中填写 DeepSeek API Key 与 API 根地址后即可对话。

## 部署

站点是静态包，由 OpenResty 提供给 `aichat.potatoblock.top`。

推送到 `main` 会跑 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：`npm ci`、`npm run build`，把 `dist/` 打成 `site.tar.gz`，更新 GitHub Release 标签 `aichat`。服务器定时器 `aichat-pull.timer`（约每 2 分钟）执行 [`deploy/pull_release.py`](deploy/pull_release.py)，把该资源换到站点目录。仓库和 workflow 里不放服务器登录信息。

手动再发布一次：GitHub → Actions → Deploy aichat → Run workflow。

## 许可与说明

仓库代码供 Potatoblock / 自用开发；调用 DeepSeek API 须遵守其服务条款与用量计费。官方 demo 与文档仅作能力对照，不表示与 DeepSeek 存在从属关系。
