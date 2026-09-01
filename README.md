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
