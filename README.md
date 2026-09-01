# dotpi

Minimal [pi](https://github.com/earendil-works/pi-mono) harness.

The point is a small tool surface and a short parent prompt, so context goes to the task instead of the harness.

| | vs stock pi |
|---|---|
| prompt | short; tool policy stays on the tools |
| `/compact` | [VCC](https://github.com/lllyasviel/VCC) — algorithmic, no extra model call |
| `search` / `scrape` | Exa + Firecrawl |
| `delegate` | isolated agent; parent waits |
| `find` / `grep` | [fff](https://github.com/dmtrKovalenko/fff) — ranked, git-aware |

## Setup

```bash
curl -fsSL https://raw.githubusercontent.com/enzofrasca/dotpi/main/setup | bash
```

Put `EXA_API_KEY` and `FIRECRAWL_API_KEY` in `~/.pi/agent/.env`

## Updating

Run the same command again — it updates the repo files and skips what already exists.

> [!WARNING]
> The script is idempotent and **never overwrites your stuff**: it pulls with `--ff-only` (refuses if you diverged), only *appends* the fff entry to `settings.json` if missing, and never touches `auth.json`, `sessions/`, or `.env`.
>
> **But:** if you already use pi and keep your own files at the same paths dotpi tracks (`extensions/defaults/`, `extensions/ui/`, etc.), they will show up as modified in git and can conflict on `git pull`. Back them up or check `git status` first.
