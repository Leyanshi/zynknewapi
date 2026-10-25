# QQ 群通知机器人

独立 Playwright 容器，使用 QQ 官方 OpenAPI。无需修改网关、数据库或创建免登录接口。

## 启用

1. 在有桌面浏览器的可信电脑进入 `integrations/qq-bot`，执行：
   ```sh
   npm ci
   npx playwright install chromium
   npm run login
   ```
   在弹出的浏览器正常登录 Root（保留 MFA/验证码），进入 `/dashboard/models`，回到终端按回车。
2. 将生成的 `state/session.json` 安全复制到服务器同一路径。该文件等同于 Root 登录凭据：目录仅允许部署用户访问，不分享、不加入版本控制、不挂载给其他服务。重新登录前先停止机器人，防止会话文件被覆盖。
3. 在服务器项目根目录的 `.env` 配置（或注入对应环境变量）：
   ```dotenv
   QQ_BOT_APP_ID=你的机器人AppID
   QQ_BOT_APP_SECRET=你的机器人AppSecret
   QQ_BOT_GROUP_OPENIDS=目标群openid
   QQ_BOT_SITE_URL=https://zynk.bot.cd
   ```
   多群用英文逗号分隔。这里是官方事件获得的 `group_openid`，不是 QQ 群号。机器人须已入群，并获得主动发消息权限；平台频控、内容审核仍然适用。本实现不接收 QQ 事件，不自动发现群。
4. 在项目根目录执行：
   ```sh
   docker compose -f docker-compose.qq-bot.yml up -d --build
   docker compose -f docker-compose.qq-bot.yml logs -f qq-bot
   ```

## 行为与限制

- 启动后发送一次数据看板截图，之后按每群上次成功发送时间每隔一小时发送；不是整点任务。
- 每 15 秒读取 Root 设置，比较调用倍率、专属倍率、删除项和备注，广播前后值。首次运行建立基线，不广播全部历史配置。
- 这是配置快照监听，不是审计事件流；两次轮询之间修改后又还原的操作不会捕获。
- 本地保存每群基线、待发文本和截图时间，失败后下轮重试。网络超时或在发送成功后、保存进度前崩溃可能导致重复消息；不保证 exactly-once。
- 仅运行一个机器人实例，不能多个实例共享 `state` 目录。
- 使用正常浏览器登录会话和现有刷新流程，不存 Root 密码，不绕过 MFA，不延长服务端会话期限。会话到期、撤销或账号权限不足会停止本轮发送并记录错误，需重新执行登录并替换会话文件。
- 截图包括 Root 模型数据看板中可见的业务数据，只配置有权查看这些数据的群。图片内存上传，不创建公开图片地址；超过上传大小上限会记录失败，分组广播不受影响。

## 检查

```sh
npm test
node --check bot.mjs
node --check login.mjs
```

认证设计参考 OWASP Authentication 和 Session Management Cheat Sheets：复用正常认证、HTTPS、会话撤销/到期生效，凭据文件限制访问，日志不输出令牌。未完成真实 Root 会话失效/撤销及 QQ 权限联调，不声明 ASVS 合规。
