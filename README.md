# OpenAgent for Obsidian

An AI agent that lives inside your vault — vault-aware, tool-capable, BYOK, and cross-platform (desktop + mobile).

> **Hackathon build:** See [hackathon/README.md](./hackathon/README.md) for the AMD Developer Hackathon: Act II submission story, AMD Developer Cloud (ROCm) setup, eval results, and demo assets.

## Features

- **OpenAI-compatible provider** — works with OpenAI, Anthropic (via proxy), Ollama, LM Studio, or any OpenAI-compatible endpoint
- **Vault tools** — read, write, edit, append, search, list notes, manage frontmatter and links
- **Consent & safety** — per-action confirmation dialogs with diff previews before any destructive write
- **BYOK** — bring your own API key; no data leaves your vault except to the endpoint you configure
- **Cross-platform** — same bundle runs on desktop (macOS / Windows / Linux) and mobile (iOS / Android)

## Installation

### From Obsidian Community Plugins

Search for **OpenAgent** in Settings → Community Plugins → Browse.
Or simply open this page and press 'Add to Obsidian': https://community.obsidian.md/plugins/open-agent

### Manual install

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest).
2. Copy them into `<vault>/.obsidian/plugins/open-agent/`.
3. In Obsidian: Settings → Community Plugins → enable **OpenAgent**.

### Mobile

Sync the plugin folder to your mobile vault's `.obsidian/plugins/open-agent/` via Obsidian Sync or any file-sync tool.

## Configuration

Open Settings → OpenAgent and fill in:

| Field | Description | Default |
|-------|-------------|---------|
| Base URL | Your provider's API endpoint | `https://api.openai.com/v1` |
| API Key | Your API key | — |
| Model | Model name to use | `gpt-4o-mini` |
| System prompt | Optional system-level instruction | — |

## Privacy & network use

This plugin makes network requests **only** to the LLM endpoint you configure (e.g. OpenAI, OpenRouter, Ollama, LM Studio). No data is sent to any other server.

With vault tools enabled, the agent may transmit note bodies, paths, frontmatter, and tags to that endpoint — only use endpoints you trust.

Your API key is stored in `.obsidian/plugins/open-agent/data.json`. If you sync your `.obsidian/` folder (e.g. via Obsidian Sync), the key travels with it.

## Development

```bash
git clone https://github.com/nikitaclicks/obsidian-openagent.git
cd obsidian-openagent
npm install
npm run dev        # esbuild watch → writes main.js
```

Then copy `main.js`, `styles.css`, and `manifest.json` into a test vault at `<vault>/.obsidian/plugins/open-agent/` and enable the plugin.

```bash
npm run build      # production bundle
npm run lint       # TypeScript ESLint
```

### Project layout

```
src/
  main.ts          # plugin entry point
  settings.ts      # settings tab + defaults
  view.ts          # chat panel UI
  loop.ts          # agent run loop
  provider.ts      # OpenAI-compatible HTTP client
  types.ts         # shared types
  tools/
    registry.ts    # tool registration
    vault/         # read / write / edit / search / list / frontmatter / links
  consent/
    manager.ts     # per-action consent state
    modal.ts       # confirmation dialogs
    render-diff.ts # diff previews
```

## Contributing

Pull requests are welcome. For larger changes, open an issue first to discuss what you'd like to change.

1. Fork the repo and create a branch from `main`.
2. Make your changes with tests where applicable.
3. Run `npm run lint` and fix any issues.
4. Open a PR — describe what changed and why.

## Roadmap

- [ ] Additional providers (Anthropic native, Google Gemini)
- [ ] MCP server support
- [ ] Inline agent commands
- [ ] Tool call history / audit log

## License

[MIT](LICENSE)
