# 参与贡献

感谢你愿意帮助改进问津！提交 issue 或 PR 之前，请花两分钟读完这份说明。

## 提 issue

- **Bug**：使用「Bug 反馈」模板，写清复现步骤、期望结果和实际结果，附上 Node.js 版本、部署方式（裸机 / Docker / 反向代理）和浏览器。
- **新功能**：使用「功能建议」模板，先说清要解决的问题，再说你设想的方案。
- **安全漏洞**：请不要公开提 issue，按 [SECURITY.md](SECURITY.md) 私下报告。
- 贴日志或截图前，请删掉 API Key、密码、邮箱、域名和 IP 等私人信息。

## 本地开发

```bash
git clone https://github.com/jihemanyouzhe-boy/wenjin-chat.git && cd wenjin-chat
cp .env.example .env            # 设置 ADMIN_PASSWORD
mkdir -p data && cp db.example.json data/db.json
node server.js                  # http://localhost:3000
```

- 不需要 `npm install`，也没有构建步骤：改完 `public/index.html` 或 `public/admin.html` 刷新浏览器即可，改了后端文件重启 `node server.js`。
- 写自动化测试时可以设置 `CAPTCHA_TEST=1`，图形验证码接口会返回答案（只限本地）。
- 没有真实 Key 时，可以在后台添加一个指向本地 mock 服务的「OpenAI 兼容」渠道来调试流式输出。

## 代码约定

- **零依赖**：后端只用 Node.js 标准库，前端不引入框架和构建工具。确实需要新依赖时，请先开 issue 讨论。
- 兼容 Node.js 18 及以上。
- 保持现有风格：`'use strict'`、两个空格缩进、单引号；注释和界面文案用简体中文。
- 安全相关的改动（转发、读网页、账号、限流）请在 PR 里说明威胁模型和测试方法。
- 不要把 `data/`、`.env`、真实 Key、真实用户数据提交进仓库。

## 提交 PR

1. Fork 仓库，从 `main` 新建分支，例如 `fix/stream-buffering`、`feat/xxx`。
2. 提交前运行语法检查：
   ```bash
   npm run check
   ```
3. 手动验证：注册 / 登录、发送一条流式消息、（如涉及）联网搜索和管理后台。
4. Commit 信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:`、`fix:`、`docs:`、`refactor:`……
5. 在 PR 描述里说明改了什么、为什么改、怎么验证；界面改动请附截图。
6. 涉及用户可见的变化，请同时更新 `CHANGELOG.md` 的「未发布」部分和 README。

## 许可

提交贡献即表示你同意你的代码以 [MIT](LICENSE) 许可证发布。
