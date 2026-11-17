# Claude Usage Bars

An [Orca](https://orca.dev) plugin that shows your Claude 5-hour and 7-day usage as colored bars in the status bar, with a countdown to each reset.

```
5h ▓▓▓▓▓░░░ 62% · 3h 15m     7d ▓▓▓▓░░░░ 41% · 2d 4h
```

Orca's built-in usage display only shows numbers. This plugin adds a bar per window, colors it by how close you are to the limit, and puts the time until reset right next to it.

## Features

- **Two status bar items**, one for the 5-hour window and one for the 7-day window, each with its own bar and percentage.
- **Color by severity**, judged per window:

  | Usage     | Color  |
  | --------- | ------ |
  | below 50% | green  |
  | 50–79%    | orange |
  | 80%+      | red    |

- **Reset countdown** in the bar itself (`3h 15m`, `2d 4h`).
- **Details on hover**: percentage, time until reset with the clock time, last update time, and the weekly Opus and Sonnet numbers when your account has them.
- **Click to refresh** either item.
- **Polite polling**: one request every 5 minutes, backing off up to 30 minutes after a failure or a 429.
- **Follows your active Orca account.** If you use several Claude accounts in Orca, the bars show the one that is currently active, and the tooltip names it. With no managed account active it falls back to the default `~/.claude` login.
- A window whose reset time has already passed shows as 0%.

## Requirements

- macOS (the Claude login is read from the macOS Keychain).
- Orca 1.4.248 or later.
- Claude Code installed and logged in on this machine, so the `Claude Code-credentials` Keychain entry exists.
- `sqlite3` on your PATH (it ships with macOS); the plugin uses it to read which account Orca has active.

## Install

Install it as a development plugin from a local clone:

```sh
git clone https://github.com/rodortega/claude-usage-bars.git
cd claude-usage-bars
orca plugin dev load .
```

Orca prints a fingerprint and refuses to run the plugin until you approve it. After reading [What it accesses](#what-it-accesses), approve it:

```sh
orca plugin dev load . --approve <fingerprint>
```

If `orca` is not on your PATH, use the binary inside the app:

```sh
/Applications/Orca.app/Contents/Resources/bin/orca plugin dev load .
```

Two items, `5h` and `7d`, then appear in the status bar. Because it is a development plugin, Orca reloads it whenever you edit the files.

To remove it:

```sh
orca plugin dev unload .
```

## What it accesses

This is a `trusted-worker` plugin: it runs its own Node.js process with your user account's access to the machine, which is why Orca asks for explicit approval. In practice it does only two things:

1. Reads which Claude account Orca has active (a read-only `sqlite3` query on Orca's `profile-state.db`), then runs `security find-generic-password -s "Claude Code-credentials[-<hash>]" -w` to read that account's Claude Code OAuth token from the Keychain.
2. Sends that token to `https://api.anthropic.com/api/oauth/usage` to read your current usage windows.

The token is held in memory for the request and is never written to disk, logged, or sent anywhere else. There is no telemetry. The whole plugin is one file, [`src/worker.ts`](src/worker.ts), so you can read it before approving.

## How it works

1. On start, and every 5 minutes after, the worker finds Orca's active Claude account, reads its token and calls the usage endpoint. Orca stores each managed account's login under a Keychain entry named `Claude Code-credentials-<first 8 hex chars of sha256(config dir)>`.
2. The response contains `five_hour` and `seven_day` windows, each with a `utilization` percentage and a `resets_at` timestamp (plus `seven_day_opus` and `seven_day_sonnet` for some plans).
3. The worker draws an 8-segment bar for each window and pushes it to the status bar with `statusBar.update`.
4. If a request fails, the items turn orange and the tooltip says why. The plugin retries with a growing delay.

Orca limits status bar text to 64 characters and gives each item a single color. That is why the two windows are separate items rather than one combined string.

## Configuration

There is no settings UI yet. To change behavior, edit the constants at the top of [`src/worker.ts`](src/worker.ts); Orca reloads the plugin when you save.

| Constant       | Default | Meaning                              |
| -------------- | ------- | ------------------------------------ |
| `POLL_MS`      | 5 min   | Time between usage requests          |
| `MAX_BACKOFF_MS` | 30 min | Longest wait after repeated failures |
| `BAR_WIDTH`    | 8       | Number of segments in each bar       |

The color thresholds are in the `tone()` function (`>= 50` orange, `>= 80` red).

## Troubleshooting

- **Nothing appears in the status bar.** Run `orca plugin list` and check the plugin says `running`. The status bar's right-click menu can also hide plugin items.
- **An item is orange with "unavailable" in the tooltip.** Hover for the reason, or run `orca plugin logs local.claude-usage-bars`.
- **"Claude Code login not found in Keychain".** Log in with Claude Code (`claude`) on this machine, then click the item to refresh.
- **Rate limited (429).** The usage endpoint can throttle frequent polling. The plugin backs off on its own; avoid lowering `POLL_MS`.
- **A bar shows 0% right after a reset.** Windows only start when you next use Claude, so an expired window reads 0% until then.

## Caveats

- The usage endpoint is not a documented public API. Anthropic may change or remove it, which would break this plugin.
- macOS only. Reading the token on other platforms is not implemented.

## Development

```sh
orca plugin validate .      # check the manifest
orca plugin dev watch .     # load the folder and stream logs and reloads
```

The plugin is written in TypeScript with no build step; Orca transpiles `src/worker.ts` when it loads it. Editor typings live in `.orca/types`, which `orca plugin dev load` regenerates and git ignores.

## License

[MIT](LICENSE)
