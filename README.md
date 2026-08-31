# lean-pi

Minimal personal harness for the [pi](https://github.com/earendil-works/pi-mono) coding agent.

This repo is meant to **be** `~/.pi/agent`. Pi’s sessions, auth, and settings stay gitignored beside it.

| Extension | Role |
|-----------|------|
| `defaults` | FFF override env + no home-scan, MCP gate, lean prompt |
| `fff` | Lean FFF `find`/`grep` (package via `settings.packages`) |
| `search-web` | Exa + Firecrawl |
| `delegate` | `delegate({ task, readonly? })` — isolated pi subprocess |
| `ui` | footer + titlebar |

`extensions/proxy/` (agy / cline / cursor / grok) is machine-local and **not** in this repo.

## Install

**Empty `~/.pi/agent` (or none yet):**

```bash
git clone https://github.com/enzofrasca/lean-pi.git ~/.pi/agent
cp ~/.pi/agent/.env.example ~/.pi/agent/.env   # EXA_API_KEY, FIRECRAWL_API_KEY
pi install npm:pi-mcp-adapter
```

**Pi already created `~/.pi/agent`:** don’t clone on top of it. Pull the tracked files in:

```bash
git clone https://github.com/enzofrasca/lean-pi.git /tmp/lean-pi
rsync -a --exclude proxy /tmp/lean-pi/extensions/ ~/.pi/agent/extensions/
cp /tmp/lean-pi/.env.example ~/.pi/agent/.env.example
# copy .env.example → .env if you don’t have one
pi install npm:pi-mcp-adapter
```

In `~/.pi/agent/settings.json`, FFF must be the **local** package (do not `pi install npm:@ff-labs/pi-fff`):

```json
{
  "packages": [
    { "source": "npm:pi-mcp-adapter" },
    "extensions/fff"
  ]
}
```

Copy `extensions/proxy/` from another machine if you use those providers. `/login <provider>` after that.

## Update

If this directory is the git clone (the usual case):

```bash
cd ~/.pi/agent
git pull
```

Ignored paths (`proxy/`, `sessions/`, `auth.json`, `settings.json`, `.env`, …) are left alone.

If you installed by copying into an existing Pi home, update the same way — `rsync` the `extensions/` tree **excluding** `proxy`. Do not `cp -R` the whole repo over `~/.pi/agent`; that can clobber local adapters and config.
