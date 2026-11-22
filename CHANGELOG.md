# 更新日志

本项目的所有重要变化都会记录在这个文件里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.0.0] - 2026-11-22

首个开源版本。

### 对话
- 多模型渠道：接入任意 OpenAI 兼容接口，以及支持思考模式开关的「DeepSeek 官方」类型
- SSE 流式输出，前端自适应打字机效果；深度思考（`reasoning_content`）可折叠显示
- 联网搜索：对接自建 SearXNG，「已搜索 N 个网页」来源面板与行内引用；模型不支持工具调用时自动「先搜再答」
- 工具调用：读网页、运行 JavaScript、生成文件、长期记忆、知识库、自定义 HTTP 工具
- 对话搜索、编辑后重发、重新生成、朗读、长对话自动压缩为可编辑的对话摘要
- 智能体（人格）模板与自定义
- 导入 DeepSeek 导出包、粘贴文字、SillyTavern 角色卡；备份 / 恢复、导出 Markdown
- 浅色 / 深色主题、PWA（可添加到手机主屏幕）

### 账号与运营
- 注册 / 登录、找回密码、自托管 SVG 图形验证码、SMTP 邮箱验证码
- 积分：注册赠送、每日签到与连续签到加成、邀请奖励、兑换码；按 token 计费
- 管理后台：概览、渠道、模型与定价、用户、兑换码、设置、调用日志

### 安全
- 渠道 Key 只存在服务器，上游报错中的 Key / 地址自动抹除
- 读网页接口防 SSRF；登录、注册、验证码、对话、联网等接口限流
- `TRUST_PROXY` 支持反向代理与 Cloudflare 的真实 IP 识别

### 部署与文档
- 零依赖 Node.js 服务，Dockerfile 与 docker-compose（可选 SearXNG profile）
- README（中文 / English）、截图、部署指南（systemd、Docker、Nginx / Caddy、Cloudflare Tunnel、HTTPS）、贡献指南、安全策略与 issue 模板

[未发布]: https://github.com/jihemanyouzhe-boy/wenjin-chat/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jihemanyouzhe-boy/wenjin-chat/releases/tag/v1.0.0
