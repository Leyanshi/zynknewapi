import { chromium } from 'playwright'
import { mkdir, chmod } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

const origin = new URL(process.env.QQ_BOT_SITE_URL || 'https://zynk.bot.cd')
if (origin.protocol !== 'https:') throw new Error('HTTPS is required')
const directory = process.env.QQ_BOT_STATE_DIR || './state'
await mkdir(directory, { recursive: true, mode: 0o700 })
const browser = await chromium.launch({ headless: false })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(new URL('/dashboard/models', origin).href)
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await terminal.question('请在浏览器正常登录 Root 账号（包含 MFA），进入数据看板后按回车保存专用会话：')
    if (new URL(page.url()).pathname !== '/dashboard/models') throw new Error('请先进入数据看板')
    await context.storageState({ path: `${directory}/session.json` })
    await chmod(`${directory}/session.json`, 0o600)
    console.log('专用会话已保存。不要分享或提交 state 目录；会话失效后重新运行 login。')
  } finally { terminal.close() }
} finally { await browser.close() }
