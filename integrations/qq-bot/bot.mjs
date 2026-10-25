import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { chromium } from 'playwright'
import { groupSnapshot, groupChanges } from './groups.mjs'

const directory = process.env.QQ_BOT_STATE_DIR || './state'
const origin = new URL(process.env.QQ_BOT_SITE_URL || 'https://zynk.bot.cd')
if (origin.protocol !== 'https:') throw new Error('QQ_BOT_SITE_URL must use HTTPS')
const appId = process.env.QQ_BOT_APP_ID
const secret = process.env.QQ_BOT_APP_SECRET
const groups = [...new Set((process.env.QQ_BOT_GROUP_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean))]
if (!appId || !secret || !groups.length) throw new Error('Configure QQ_BOT_APP_ID, QQ_BOT_APP_SECRET and QQ_BOT_GROUP_OPENIDS')
await mkdir(directory, { recursive: true, mode: 0o700 })

async function save(name, value) {
  await writeFile(`${directory}/${name}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${directory}/${name}.tmp`, `${directory}/${name}`)
}
let history = {}
try { history = JSON.parse(await readFile(`${directory}/history.json`, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
let botToken = ''
let botExpiry = 0

async function qq(path, payload) {
  if (Date.now() >= botExpiry) {
    const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }), signal: AbortSignal.timeout(20000),
    })
    const result = await response.json()
    if (!response.ok || result.code || !result.access_token) throw new Error(`QQ token failed: HTTP ${response.status}, code ${result.code || 0}`)
    const seconds = Number(result.expires_in)
    if (!Number.isFinite(seconds) || seconds <= 60) throw new Error('Invalid QQ token expiry')
    botToken = result.access_token
    botExpiry = Date.now() + (seconds - 60) * 1000
  }
  const response = await fetch(`https://api.bot.qq.com${path}`, {
    method: 'POST', headers: { Authorization: `QQBot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
  })
  const result = await response.json()
  if (response.status === 401) botExpiry = 0
  if (!response.ok || result.code) throw new Error(`QQ request failed: HTTP ${response.status}, code ${result.code || 0}`)
  return result
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  storageState: `${directory}/session.json`, viewport: { width: 1600, height: 1100 },
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
})
const page = await context.newPage()
page.setDefaultTimeout(60000)
let accessToken = ''
// Observe only the application's normal login-session refresh. No auth bypass,
// password storage, PAT injection or credentials exposed in URLs/logs.
page.on('response', async response => {
  if (response.url() !== new URL('/api/user/auth/refresh', origin).href) return
  try {
    const body = await response.json()
    if (body.success && body.data?.access_token) accessToken = body.data.access_token
  } catch { /* Navigation can cancel a response. Fail closed below. */ }
})

async function site(path) {
  if (!accessToken) throw new Error('Root session unavailable: run login again')
  const response = await context.request.get(new URL(path, origin).href, {
    headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000, maxRedirects: 0,
  })
  const body = await response.json()
  if (!response.ok() || !body.success) throw new Error(`Dashboard API failed: HTTP ${response.status()}`)
  return body.data
}

async function openDashboard() {
  accessToken = ''
  await page.goto(new URL('/dashboard/models', origin).href, { waitUntil: 'networkidle' })
  const user = await site('/api/user/self')
  if (user.role !== 100) throw new Error('A live Root login session is required')
  if (new URL(page.url()).pathname !== '/dashboard/models') throw new Error('Dashboard redirected to login')
  await save('session.json', await context.storageState())
}

async function screenshot() {
  // Expand the existing dashboard scroll container instead of capturing only
  // its viewport. Do not alter the application or create a public image URL.
  await page.locator('main canvas').first().waitFor({ state: 'visible' })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.addStyleTag({ content: 'main, main * { animation: none !important; transition: none !important; } main, main .overflow-auto { overflow: visible !important; height: auto !important; max-height: none !important; }' })
  const image = await page.locator('main').screenshot({ type: 'jpeg', quality: 80, animations: 'disabled' })
  if (image.length > 4 * 1024 * 1024) throw new Error('Dashboard image exceeds direct upload limit')
  return image.toString('base64')
}

let stopped = false
process.on('SIGTERM', () => { stopped = true })
process.on('SIGINT', () => { stopped = true })
let lastOpened = 0
try {
  while (!stopped) {
    try {
      const now = Date.now()
      const imageDue = groups.some(group => now - (history[group]?.lastImage || 0) >= 3600000)
      if (imageDue || now - lastOpened >= 300000 || !accessToken) {
        await openDashboard()
        lastOpened = now
      }
      const snapshot = groupSnapshot(await site('/api/option/'))
      let image = null
      if (imageDue) {
        try { image = await screenshot() }
        catch (error) { console.error(new Date().toISOString(), `Screenshot failed: ${error.message}`) }
      }
      for (const group of groups) {
        try {
          const state = history[group] ||= {}
          // Persist the pending chunks so a successful chunk is not resent when
          // a subsequent chunk fails. First startup establishes a baseline.
          if (!state.snapshot) state.snapshot = snapshot
          if (!state.pending) {
            state.pending = groupChanges(state.snapshot, snapshot)
            state.target = snapshot
          }
          await save('history.json', history)
          while (state.pending.length) {
            await qq(`/v2/groups/${encodeURIComponent(group)}/messages`, { msg_type: 0, content: state.pending[0] })
            state.pending.shift()
            await save('history.json', history)
          }
          state.snapshot = state.target
          delete state.target
          delete state.pending
          if (image && now - (state.lastImage || 0) >= 3600000) {
            const file = await qq(`/v2/groups/${encodeURIComponent(group)}/files`, {
              file_type: 1, file_name: 'dashboard.jpg', file_data: image, srv_send_msg: false,
            })
            if (!file.file_info) throw new Error('QQ returned no file_info')
            await qq(`/v2/groups/${encodeURIComponent(group)}/messages`, { msg_type: 7, media: { file_info: file.file_info } })
            state.lastImage = Date.now()
          }
          await save('history.json', history)
        } catch (error) { console.error(new Date().toISOString(), `Group delivery failed: ${error.message}`) }
      }
    } catch (error) { console.error(new Date().toISOString(), error.message) }
    await new Promise(resolve => setTimeout(resolve, 15000))
  }
} finally { await browser.close() }
