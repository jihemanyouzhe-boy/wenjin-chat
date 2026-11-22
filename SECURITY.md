# 安全策略

## 支持的版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| 1.x（最新） | ✅ |

请始终使用最新版本；安全修复只发布在最新的 1.x 版本上。

## 报告漏洞

**请不要通过公开 issue、讨论区或 PR 报告安全问题。**

请使用 GitHub 的私密漏洞报告功能：进入仓库的 **Security → Advisories → Report a vulnerability**（[直达链接](https://github.com/jihemanyouzhe-boy/wenjin-chat/security/advisories/new)）。

报告中请尽量包含：

- 漏洞类型和影响（例如 SSRF、越权、Key 泄露、XSS、限流绕过）
- 受影响的文件 / 接口和版本（commit）
- 复现步骤或 PoC
- 你建议的修复方式（可选）

我们会在 7 天内确认收到，并在修复发布前与你保持沟通。修复发布后，如你愿意，会在公告中致谢。

## 范围

特别关注以下方面：

- 渠道 API Key 泄露到浏览器或日志
- `/api/tools/read` 读网页接口的 SSRF 绕过
- 账号、管理员会话、积分与兑换码的越权或绕过
- 限流、图形验证码、邮箱验证码的绕过
- 前端渲染模型输出时的 XSS

以下情况不在范围内：部署者自己的配置问题（例如未设置 `ADMIN_PASSWORD`、生产环境开启 `CAPTCHA_TEST`、把 SearXNG 暴露到公网）、第三方模型服务商或 SearXNG 自身的漏洞、需要物理接触服务器的攻击。

## 部署者自查

部署前请对照 README 的「安全说明」一节检查配置。
