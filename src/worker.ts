// Draws Claude 5h / 7d usage as bars in Orca's status bar.
// Reads the Claude Code OAuth token from the macOS Keychain and asks Anthropic's usage
// endpoint for the current windows. The token is only ever sent to api.anthropic.com.
import { execFile } from 'node:child_process'
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

function readToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return reject(new Error('Claude Code login not found in Keychain'))
        try {
          const token = JSON.parse(stdout).claudeAiOauth?.accessToken
          if (typeof token !== 'string' || !token) throw new Error('no token')
          resolve(token)
        } catch {
          reject(new Error('Could not read Claude Code login'))
        }
      }
    )
  })
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

  async function refresh(): Promise<number> {
    try {
      const usage = await fetchUsage(await readToken())
      const opus = pct(usage.seven_day_opus)
      const sonnet = pct(usage.seven_day_sonnet)
      const weekly = [
        ...(opus !== null ? [`Opus ${opus}%`] : []),
        ...(sonnet !== null ? [`Sonnet ${sonnet}%`] : [])
      ]
      failures = 0
      await Promise.all([
        showWindow('five', '5h', usage.five_hour, []),
        showWindow('seven', '7d', usage.seven_day, weekly)
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
