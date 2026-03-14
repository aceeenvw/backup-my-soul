# Chat Backup — SillyTavern Extension

A simple extension to back up your SillyTavern chats with one click.

## Features

- **Backup Current Chat** — saves the open chat as a `.jsonl` file
- **Backup All Chats (Current Character)** — saves every chat file for the selected character
- **Backup Everything (All Characters)** — iterates all characters and backs up every chat, organized into subfolders

### Desktop (Chrome / Edge)
Pick a folder via the native OS folder picker. Files are written directly into it. "Backup Everything" creates a subfolder per character automatically.

### Mobile / Firefox
Folder picker isn't available — bulk backups download as a single `.zip` file with the same folder structure inside.

## Installation

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste the repository URL and click Install
4. Reload SillyTavern

The **Chat Backup** panel will appear in the Extensions settings drawer.

## Usage

1. *(Desktop only)* Click **Choose Folder** to select where backups go
2. Toggle **Include timestamp in filename** if you want dated filenames
3. Click one of the three backup buttons

> **Note:** Folder access only lasts for the current session. After restarting SillyTavern, re-select the folder.

## Requirements

- SillyTavern 1.12+
- Chrome, Edge, or any Chromium browser for folder picker support
- Safari / Firefox / iOS work with .zip fallback

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Extension metadata |
| `index.js` | Core logic — UI, API calls, folder/zip handling |
| `style.css` | Panel styling |

## Author

**aceenvw**

## License

MIT
