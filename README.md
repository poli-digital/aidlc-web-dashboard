# AIDLC Web Dashboard

A standalone, browser-based real-time dashboard for [AI-DLC v2](https://github.com/v-hansen/aidlc-dashboard) workflows. It reads the `aidlc/` folder that the AI-DLC engine writes to your project and visualizes workflow status: phases, stages, approval gates, learned rules, audit trail and consumption (tokens/credits) — including cost per stage.

> This is the **web server** variant of the AIDLC Dashboard. Unlike the standalone HTML (which requires Chrome's File System Access API) or the VS Code extension, this version runs anywhere — any browser, any OS — powered by a lightweight Node.js backend.

## Why this exists

| Variant | Requires | Use case |
|---------|----------|----------|
| [dashboard.html](https://github.com/v-hansen/aidlc-dashboard) | Chrome/Edge/Opera | Quick single-file, no install |
| [.vsix extension](https://github.com/v-hansen/aidlc-dashboard) | Kiro IDE / VS Code | Integrated editor experience |
| **This (web server)** | Node.js ≥ 18 | Any browser, remote access, multiple projects |

## Features

- **Real-time updates** — file watcher pushes changes instantly via WebSocket (no polling)
- **Multiple projects** — run multiple instances simultaneously (auto-selects free ports starting from 3939)
- **Interactive prompt** — if no path is given, asks you to paste the project path
- **Token tracking** — reads Claude Code transcripts (`~/.claude/projects/`) and Kiro sessions (`~/.kiro/sessions/`) automatically
- **Cost per stage** — attributes token/credit consumption to each workflow stage by matching timestamps
- **Trilingual UI** — English, Portuguese and Spanish (auto-detected, manual selector)
- **Fully local** — no data leaves your machine

## Quick Start

```bash
# Clone and install
git clone https://github.com/poli-digital/aidlc-web-dashboard.git
cd aidlc-web-dashboard/aidlc-dashboard-web
npm install

# Start with project path
npm run server -- /path/to/your/project

# Or start without path (interactive prompt)
npm run server
#  📂 Cole o caminho completo do projeto: _
```

Then open the URL shown in your terminal (e.g. `http://localhost:3939`).

## Running Multiple Projects

Each instance automatically picks the next free port:

```bash
# Terminal 1
npm run server -- /path/to/project-a
#  → http://localhost:3939

# Terminal 2
npm run server -- /path/to/project-b
#  → http://localhost:3940
```

## How It Works

```
┌─────────────────┐         WebSocket          ┌──────────────┐
│  Browser (any)  │ ◄────────────────────────► │  Node.js     │
│                 │    real-time push/pull      │  server.js   │
│  core.js        │                            │              │
│  bridge.js      │                            │  fs.watch()  │
│  dashboard.css  │                            │  on aidlc/   │
└─────────────────┘                            └──────────────┘
```

1. **server.js** reads the `aidlc/` folder structure (intents, state, runtime graph, audit logs, memory)
2. A recursive `fs.watch` detects any file change inside `aidlc/`
3. Changes are broadcast to all connected browsers via WebSocket
4. **bridge.js** receives the data and feeds it to **core.js** (the same rendering engine used by the VS Code extension)

## REST API

For scripting or integration:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/project` | GET | Returns current project path |
| `/api/project` | POST | Sets project path `{ "path": "/..." }` |
| `/api/dashboard` | GET | Returns full dashboard data (JSON) |
| `/api/tokens` | GET | Returns token/credit consumption data |

## Requirements

- **Node.js ≥ 18**
- An AI-DLC v2 workflow (the dashboard reads its `aidlc/` folder) — any harness: Kiro IDE, Kiro CLI or Claude Code
- Any modern browser (no File System Access API needed)

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3939` | Base port (auto-increments if busy) |

## Notes

- Everything runs locally — no data leaves your machine
- Workflow files are treated as untrusted input (HTML-escaped before rendering)
- USD costs for Claude Code are estimates based on reference pricing; for exact billing on AWS Bedrock, use Cost Explorer / CloudWatch
- Token attribution to stages uses timestamp matching against each stage's execution window

## License

MIT
