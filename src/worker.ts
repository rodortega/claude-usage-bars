// Draws Claude 5h / 7d usage as bars in Orca's status bar.
// Follows the Claude account Orca currently uses (click the account item to switch it), reads its Claude Code OAuth token from
// the macOS Keychain and asks Anthropic's usage endpoint for the current windows.
// The token is only ever sent to api.anthropic.com.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 30 * 60 * 1000
const BAR_WIDTH = 8

type Window = { utilization: number | null; resets_at: string | null } | null
type Usage = {
  five_hour?: Window
  seven_day?: Window
  seven_day_opus?: Window
  seven_day_sonnet?: Window
}

const DEFAULT_SERVICE = 'Claude Code-credentials'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  })
}

type Account = { key: string; service: string; configDir: string | null; label: string; active: boolean }

async function labelFor(configDir: string | null): Promise<string> {
  try {
    const file = join(configDir ?? homedir(), '.claude.json')
    const email = JSON.parse(await readFile(file, 'utf8')).oauthAccount?.emailAddress
    if (typeof email === 'string' && email) return email
  } catch {
    // No label available.
  }
  return configDir ? `profile ${configDir.split('/').slice(-2, -1)[0].slice(0, 8)}` : 'default login'
}

const ORCA_CLI = process.env.ORCA_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'

/**
 * Asks Orca for its managed Claude accounts (`orca account list`) plus the default login
 * (`~/.claude`, which Orca calls "system"), marking the one Orca currently uses. Claude Code
 * stores each login in a Keychain entry named `Claude Code-credentials-<sha256(dir)[0:8]>`.
 */
async function listAccounts(): Promise<Account[]> {
  let claude: { accounts?: { id?: unknown; email?: unknown; home?: unknown }[]; activeAccountId?: unknown } = {}
  try {
    claude = JSON.parse(await run(ORCA_CLI, ['account', 'list', '--json']))?.result?.claude ?? {}
  } catch {
    // Orca's CLI is unreachable: only the default login is offered.
  }
  const activeId = typeof claude.activeAccountId === 'string' ? claude.activeAccountId : null
  const accounts: Account[] = []
  for (const a of claude.accounts ?? []) {
    if (typeof a.id !== 'string' || typeof a.home !== 'string') continue
    accounts.push({
      key: a.id,
      service: `${DEFAULT_SERVICE}-${createHash('sha256').update(a.home).digest('hex').slice(0, 8)}`,
      configDir: a.home,
      label: typeof a.email === 'string' && a.email ? a.email : await labelFor(a.home),
      active: a.id === activeId
    })
  }
  accounts.push({
    key: 'system',
    service: DEFAULT_SERVICE,
    configDir: null,
    label: await labelFor(null),
    active: !accounts.some((x) => x.active)
  })
  return accounts
}

/** Makes Orca use this account for new agent launches (running agents keep theirs). */
async function selectAccount(key: string): Promise<void> {
  await run(ORCA_CLI, ['account', 'select', '--agent', 'claude', '--account', key])
}

async function readToken(service: string): Promise<string> {
  let stdout: string
  try {
    stdout = await run('security', ['find-generic-password', '-s', service, '-w'])
  } catch {
    throw new Error('Claude Code login not found in Keychain')
  }
  try {
    const token = JSON.parse(stdout).claudeAiOauth?.accessToken
    if (typeof token !== 'string' || !token) throw new Error('no token')
    return token
  } catch {
    throw new Error('Could not read Claude Code login')
  }
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('rate limited')
  }
}

async function fetchUsage(token: string): Promise<Usage> {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15_000)
  })
  if (res.status === 429) {
    const secs = Number(res.headers.get('retry-after'))
    throw new RateLimited(Number.isFinite(secs) && secs > 0 ? secs * 1000 : POLL_MS * 2)
  }
  if (!res.ok) throw new Error(`usage request failed (${res.status})`)
  return (await res.json()) as Usage
}

/** A window whose reset time already passed has no active usage; show it as 0. */
function pct(w: Window | undefined): number | null {
  if (!w || typeof w.utilization !== 'number') return null
  if (w.resets_at && Date.parse(w.resets_at) < Date.now()) return 0
  return Math.max(0, Math.min(100, Math.round(w.utilization)))
}

function bar(percent: number): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH)
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

function untilReset(w: Window | undefined): string {
  if (!w?.resets_at) return 'no active window'
  const ms = Date.parse(w.resets_at) - Date.now()
  if (ms <= 0) return 'no active window'
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const dur = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  const at = new Date(w.resets_at).toLocaleString([], {
    weekday: d > 0 ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  return `resets in ${dur} (${at})`
}

function tone(percent: number): 'success' | 'warning' | 'danger' {
  if (percent >= 80) return 'danger'
  if (percent >= 50) return 'warning'
  return 'success'
}

/** Short countdown for the bar, e.g. "3h 15m" or "2d 4h"; empty when no window is active. */
function shortReset(w: Window | undefined): string {
  if (!w?.resets_at) return ''
  const mins = Math.floor((Date.parse(w.resets_at) - Date.now()) / 60_000)
  if (mins <= 0) return ''
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function activate(orca: OrcaWorkerApi): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let stopped = false

  const show = (id: string, patch: Omit<Parameters<typeof orca.host.call<'statusBar.update'>>[1], 'id'>) =>
    orca.host.call('statusBar.update', { id, ...patch }).catch((e: unknown) => {
      orca.log(`statusBar.update failed: ${String(e)}`)
    })

  const updated = () =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

  async function showWindow(id: string, label: string, w: Window | undefined, extra: string[]) {
    const p = pct(w)
    if (p === null) return show(id, { text: `${label} n/a`, tone: 'neutral', tooltip: `${label}: no data` })
    const reset = shortReset(w)
    const tooltip = [`${label}: ${p}% used`, untilReset(w), ...extra, `Updated ${updated()} · click to refresh`]
    return show(id, {
      text: `${label} ${bar(p)} ${p}%${reset ? ` · ${reset}` : ''}`,
      tone: tone(p),
      tooltip: tooltip.join(' | ').slice(0, 256),
      visible: true
    })
  }

  async function currentAccount(): Promise<{ all: Account[]; current: Account }> {
    const all = await listAccounts()
    return { all, current: all.find((a) => a.active) ?? all[all.length - 1] }
  }

  async function showAccount(all: Account[], current: Account) {
    const lines = all.map((a) => `${a === current ? '▶' : '·'} ${a.label}`)
    return show('account', {
      text: current.label,
      tooltip: [...lines, 'Click to switch Orca to the next account (applies to new agent launches)']
        .join(' | ')
        .slice(0, 256),
      visible: true
    })
  }

  async function refresh(): Promise<number> {
    try {
      const { all, current } = await currentAccount()
      await showAccount(all, current)
      const usage = await fetchUsage(await readToken(current.service))
      const opus = pct(usage.seven_day_opus)
      const sonnet = pct(usage.seven_day_sonnet)
      const weekly = [
        ...(opus !== null ? [`Opus ${opus}%`] : []),
        ...(sonnet !== null ? [`Sonnet ${sonnet}%`] : [])
      ]
      failures = 0
      await Promise.all([
        showWindow('five', '5h', usage.five_hour, [`Account: ${current.label}`]),
        showWindow('seven', '7d', usage.seven_day, [`Account: ${current.label}`, ...weekly])
      ])
      return POLL_MS
    } catch (e) {
      failures += 1
      const msg = e instanceof Error ? e.message : String(e)
      orca.log(`refresh failed (${failures}): ${msg}`)
      const tooltip = `Claude usage unavailable: ${msg}`.slice(0, 256)
      await Promise.all([show('five', { tone: 'warning', tooltip }), show('seven', { tone: 'warning', tooltip })])
      if (e instanceof RateLimited) return Math.min(e.retryAfterMs, MAX_BACKOFF_MS)
      return Math.min(POLL_MS * 2 ** Math.min(failures, 3), MAX_BACKOFF_MS)
    }
  }

  async function loop(): Promise<void> {
    if (stopped) return
    const next = await refresh()
    if (!stopped) timer = setTimeout(loop, next)
  }

  /** Switches Orca itself to the next Claude account, wrapping around. */
  orca.commands.register('usage.switch', async () => {
    const { all, current } = await currentAccount()
    const next = all[(all.indexOf(current) + 1) % all.length]
    if (next === current) return 'Only one Claude account is available'
    await selectAccount(next.key)
    if (timer) clearTimeout(timer)
    await loop()
    return `Orca now uses ${next.label}`
  })

  orca.commands.register('usage.refresh', async () => {
    if (timer) clearTimeout(timer)
    await loop()
    return 'Claude usage refreshed'
  })

  void loop()
  ;(globalThis as { __claudeUsageStop?: () => void }).__claudeUsageStop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export function deactivate(): void {
  ;(globalThis as { __claudeUsageStop?: () => void }).__claudeUsageStop?.()
}
