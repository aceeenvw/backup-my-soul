# Backup My Soul

SillyTavern extension for backing up character chats — from a single conversation to everything at once.

## Features

### Backup Modes
- **Current Chat** — saves the open chat as a `.jsonl` file
- **All Chats (Current Character)** — collects every chat for the selected character
- **Backup Everything** — opens a character picker modal, lets you select who to backup, then processes all their chats

### Character Picker
- Visual list with avatars and checkboxes
- Search by name in real-time
- Select All / None buttons
- All characters selected by default

### Storage
- **Desktop (Chrome/Edge)** — native folder picker, files saved directly to disk with subfolder per character
- **Mobile / Firefox** — automatic `.zip` fallback with the same folder structure inside

### UX
- Progress bar with per-character status
- Cancel button for long operations
- Timestamp toggle for filenames
- Session-scoped folder access with re-select prompt after restart

## Installation

1. Download or clone this repository
2. Place the folder in `SillyTavern/data/default-user/extensions/`
3. Restart SillyTavern or reload the page
4. Find the extension in **Extensions** panel -> **Backup My Soul**

## Usage

### Quick Backup
1. Open a chat with any character
2. Open **Backup My Soul** in Extensions
3. Click **Backup Current Chat** — file downloads immediately

### Bulk Backup
1. *(Desktop only)* Click **Choose Folder** to set a save location
2. Click **All Chats (Current Character)** or **Backup Everything**
3. For "Backup Everything" — pick characters in the modal, click **Backup**
4. Progress bar tracks each character and chat file
5. Cancel anytime without losing already saved files

### Options
- **Include timestamp** — appends `_2026-04-17_12-30` to filenames
- **Folder picker** — saves directly to disk (desktop browsers only)

## File Structure

Backups are organized as:
```
selected_folder/
  Character_Name/
    2024-01-15@12h30m.jsonl
    2024-02-20@09h15m.jsonl
  Another_Character/
    ...
```

Or as a `.zip` with the same structure when folder picker is unavailable.

## Requirements

- SillyTavern 1.12+
- Chrome, Edge, or Chromium for folder picker
- Any browser works with .zip fallback

## Version

**v2.0.0** — by aceenvw

## License

Free to use and modify.
