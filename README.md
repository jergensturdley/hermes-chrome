# Hermes Chrome

Chrome side panel for a local Hermes Agent gateway.

## Features

- Chat with Hermes from Chrome's side panel
- Auto-detect a local gateway
- Optional page context: title, URL, language, and visible text excerpt
- Hermes session API support, so conversations can appear in Hermes session history
- Runtime controls for provider, model, and base URL
- Slash command palette with keyboard and mouse navigation
- Local storage only; no analytics or remote services

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder.
5. Click the Hermes toolbar icon to open the side panel.

## Settings

Open settings from the gear button in the side panel.

- **Gateway URL**: defaults to `http://127.0.0.1:8642`
- **API key**: optional; only needed if Hermes was started with `API_SERVER_KEY`
- **Provider / model / base URL**: loaded from Hermes and can be applied back to Hermes
- **Use Hermes session API**: recommended; keeps chat state in Hermes sessions
- **Include page context**: sends browser page context with each message
- **System prompt**: default instruction sent with conversations

## Hermes API use

The extension prefers:

```text
/api/sessions/{id}/chat/stream
```

It falls back to:

```text
/v1/chat/completions
```

The extension also reads:

```text
/api/config
/api/available-models
/api/skills
```

## Slash commands

Type `/` in the chat input to open the command palette.

Navigation:

- `ArrowUp` / `ArrowDown`: move selection
- `Tab` or `Enter`: accept selected command
- Mouse wheel / trackpad: scroll command list
- `Escape`: close palette
- `//`: send a literal message that starts with `/`

## Privacy

- Talks to localhost by default
- Stores settings and chat cache in `chrome.storage.local`
- Does not bundle telemetry, analytics, or external network calls

## Development

Useful checks:

```bash
node --check background.js
node --check sidepanel.js
node --check options.js
python3 -m json.tool manifest.json >/dev/null
```

## License

MIT
