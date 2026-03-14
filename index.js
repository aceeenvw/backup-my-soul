// Chat Backup Extension v1.7 — by aceenvw
const MODULE_NAME = 'chat_backup';

const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

const defaultSettings = Object.freeze({
    includeTimestamp: true,
    folderName: '',
});

let directoryHandle = null;
let jsZipLoaded = false;

// ─── Load JSZip dynamically ───
async function loadJSZip() {
    if (jsZipLoaded && window.JSZip) return true;
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.onload = () => { jsZipLoaded = true; resolve(true); };
        script.onerror = () => { console.error(`[${MODULE_NAME}] Failed to load JSZip`); resolve(false); };
        document.head.appendChild(script);
    });
}

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

function getHeaders() {
    if (typeof window.getRequestHeaders === 'function') return window.getRequestHeaders();
    const ctx = SillyTavern.getContext();
    if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    return { 'Content-Type': 'application/json' };
}

function supportsDirectoryPicker() {
    return typeof window.showDirectoryPicker === 'function';
}

// ─── Folder picker ───

async function pickFolder() {
    if (!supportsDirectoryPicker()) {
        toastr.error('Folder picker not supported in this browser. Backups will download as .zip files instead.');
        return;
    }
    try {
        directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const settings = getSettings();
        settings.folderName = directoryHandle.name;
        saveSettingsDebounced();
        updateFolderDisplay();
        toastr.success(`Backup folder set: ${directoryHandle.name}`);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error(`[${MODULE_NAME}]`, err);
            toastr.error('Failed to select folder.');
        }
    }
}

function updateFolderDisplay() {
    const el = document.getElementById('chat_backup_folder_display');
    if (!el) return;
    const settings = getSettings();
    if (directoryHandle) {
        el.textContent = `📂 ${directoryHandle.name} (active)`;
    } else if (settings.folderName) {
        el.textContent = `📂 ${settings.folderName} (re-select needed after restart)`;
    } else {
        el.textContent = supportsDirectoryPicker()
            ? 'No folder selected'
            : '⚠️ Folder picker not supported — will download as .zip';
    }
}

async function getOrCreateSubfolder(parentHandle, name) {
    return await parentHandle.getDirectoryHandle(name.replace(/[<>:"/\\|?*]/g, '_'), { create: true });
}

async function writeToHandle(handle, content, filename) {
    try {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            const req = await handle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') { toastr.error('Permission denied.'); return false; }
        }
        const fh = await handle.getFileHandle(filename, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
        return true;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Write error for ${filename}:`, err);
        return false;
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadFile(content, filename) {
    downloadBlob(new Blob([content], { type: 'application/jsonl' }), filename);
}

async function saveFile(content, filename, subfolder) {
    if (directoryHandle) {
        let target = directoryHandle;
        if (subfolder) target = await getOrCreateSubfolder(directoryHandle, subfolder);
        return await writeToHandle(target, content, filename);
    }
    downloadFile(content, filename);
    return true;
}

// ─── Character helpers ───

function getCurrentCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        const g = ctx.groups?.find(g => g.id === ctx.groupId);
        return g?.name || 'group_chat';
    }
    if (ctx.characterId != null) return ctx.characters[ctx.characterId]?.name || 'unknown';
    return null;
}

function getCurrentCharAvatar() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId != null) return ctx.characters[ctx.characterId]?.avatar;
    return null;
}

function safeName(name) {
    return name.replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '_');
}

function setStatus(text) {
    const el = document.getElementById('chat_backup_status');
    if (el) el.textContent = text;
}

// ─── Extract chat filename from API response ───

function extractChatFileName(chatInfo) {
    if (typeof chatInfo === 'string') return chatInfo;
    if (chatInfo.file_name) return chatInfo.file_name;
    if (chatInfo.fileName) return chatInfo.fileName;

    const keys = Object.keys(chatInfo);
    for (const key of keys) {
        if (key.endsWith('.jsonl') || /^\d{4}/.test(key) || key.includes('@')) return key;
    }

    if (keys.length > 0) {
        console.warn(`[${MODULE_NAME}] Unknown chat item format:`, JSON.stringify(chatInfo));
        return keys[0];
    }
    return null;
}

// ─── API calls ───

async function fetchChatList(avatar) {
    const headers = getHeaders();
    const endpoints = [
        { url: '/api/characters/chats', body: { avatar_url: avatar } },
        { url: '/getallchatsofcharacter', body: { avatar_url: avatar } },
    ];

    for (const ep of endpoints) {
        try {
            const r = await fetch(ep.url, { method: 'POST', headers, body: JSON.stringify(ep.body) });
            if (r.ok) {
                const d = await r.json();
                console.log(`[${MODULE_NAME}] Chat list from ${ep.url}:`, JSON.stringify(d).slice(0, 500));
                if (Array.isArray(d) && d.length > 0) return d;
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] ${ep.url} failed:`, e);
        }
    }
    return null;
}

async function fetchSingleChat(charName, chatFileName, avatar) {
    const headers = getHeaders();
    const cleanName = chatFileName.replace('.jsonl', '');
    console.log(`[${MODULE_NAME}] Fetching: ch_name="${charName}", file_name="${cleanName}"`);

    const endpoints = [
        { url: '/api/chats/get', body: { ch_name: charName, file_name: cleanName, avatar_url: avatar } },
        { url: '/getchat', body: { ch_name: charName, file_name: cleanName, avatar_url: avatar } },
    ];

    for (const ep of endpoints) {
        try {
            const r = await fetch(ep.url, { method: 'POST', headers, body: JSON.stringify(ep.body) });
            if (r.ok) {
                const data = await r.json();
                console.log(`[${MODULE_NAME}] Got chat from ${ep.url}: ${Array.isArray(data) ? data.length + ' msgs' : typeof data}`);
                return data;
            } else {
                console.warn(`[${MODULE_NAME}] ${ep.url} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] ${ep.url} failed:`, e);
        }
    }
    return null;
}

// ─── Collect chats for a character (returns array of {filename, content}) ───

async function collectCharacterChats(charName, avatar) {
    const chats = await fetchChatList(avatar);
    if (!chats || chats.length === 0) return [];

    console.log(`[${MODULE_NAME}] ${charName}: ${chats.length} chats. First:`, JSON.stringify(chats[0]));

    const results = [];
    for (let i = 0; i < chats.length; i++) {
        const chatFileName = extractChatFileName(chats[i]);
        if (!chatFileName) continue;

        setStatus(`${charName}: ${i + 1}/${chats.length} — ${chatFileName}`);

        const chatData = await fetchSingleChat(charName, chatFileName, avatar);
        if (chatData && Array.isArray(chatData) && chatData.length > 0) {
            const content = chatData.map(msg => JSON.stringify(msg)).join('\n');
            const fname = chatFileName.endsWith('.jsonl') ? chatFileName : `${chatFileName}.jsonl`;
            results.push({ filename: fname, content });
        }
        await new Promise(r => setTimeout(r, 200));
    }
    return results;
}

// ─── Backup current chat ───

async function backupCurrentChat() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    const charName = getCurrentCharName();

    if (!charName) { toastr.warning('No character or group selected.'); return; }
    if (!chat || chat.length === 0) { toastr.warning('No messages in the current chat.'); return; }

    const settings = getSettings();
    const ts = settings.includeTimestamp ? `_${getTimestamp()}` : '';
    const filename = `${safeName(charName)}_chat${ts}.jsonl`;
    const content = chat.map(msg => JSON.stringify(msg)).join('\n');

    const ok = await saveFile(content, filename);
    if (ok) toastr.success(`Backed up: ${filename}`);
}

// ─── Backup all chats for current character ───

async function backupCurrentCharAllChats() {
    const charName = getCurrentCharName();
    const avatar = getCurrentCharAvatar();
    if (!charName || !avatar) { toastr.warning('No character selected.'); return; }

    setStatus(`Fetching chats for ${charName}...`);
    const chatFiles = await collectCharacterChats(charName, avatar);

    if (chatFiles.length === 0) {
        setStatus('');
        toastr.error(`No chats found for ${charName}. Check console (F12).`);
        return;
    }

    // If we have a folder handle, write individually
    if (directoryHandle) {
        let saved = 0;
        for (const cf of chatFiles) {
            const ok = await saveFile(cf.content, cf.filename);
            if (ok) saved++;
        }
        setStatus('');
        toastr.success(`Backed up ${saved}/${chatFiles.length} chats for ${charName}.`);
        return;
    }

    // No folder → download as zip
    setStatus('Creating zip file...');
    const ok = await loadJSZip();
    if (!ok) { toastr.error('Failed to load JSZip library.'); setStatus(''); return; }

    const zip = new JSZip();
    for (const cf of chatFiles) {
        zip.file(cf.filename, cf.content);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const ts = getTimestamp();
    downloadBlob(blob, `${safeName(charName)}_all_chats_${ts}.zip`);
    setStatus('');
    toastr.success(`Downloaded ${chatFiles.length} chats for ${charName} as .zip`);
}

// ─── Backup ALL chats from ALL characters ───

async function backupEverything() {
    const ctx = SillyTavern.getContext();
    const characters = ctx.characters;

    if (!characters || characters.length === 0) { toastr.warning('No characters found.'); return; }

    // If we have folder handle, write to subfolders
    if (directoryHandle) {
        let totalChars = 0, totalSaved = 0;
        for (let i = 0; i < characters.length; i++) {
            const char = characters[i];
            if (!char.avatar) continue;
            const charName = char.name || 'unknown';

            setStatus(`[${i + 1}/${characters.length}] ${charName}...`);
            const chatFiles = await collectCharacterChats(charName, char.avatar);

            if (chatFiles.length > 0) {
                totalChars++;
                const subfolder = safeName(charName);
                for (const cf of chatFiles) {
                    const ok = await saveFile(cf.content, cf.filename, subfolder);
                    if (ok) totalSaved++;
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        setStatus('');
        toastr.success(`Done! ${totalSaved} chats from ${totalChars} characters.`);
        return;
    }

    // No folder → build one big zip with subfolders
    setStatus('Loading zip library...');
    const ok = await loadJSZip();
    if (!ok) { toastr.error('Failed to load JSZip library.'); setStatus(''); return; }

    const zip = new JSZip();
    let totalChars = 0, totalFiles = 0;

    for (let i = 0; i < characters.length; i++) {
        const char = characters[i];
        if (!char.avatar) continue;
        const charName = char.name || 'unknown';

        setStatus(`[${i + 1}/${characters.length}] ${charName}...`);
        const chatFiles = await collectCharacterChats(charName, char.avatar);

        if (chatFiles.length > 0) {
            totalChars++;
            const folder = zip.folder(safeName(charName));
            for (const cf of chatFiles) {
                folder.file(cf.filename, cf.content);
                totalFiles++;
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }

    if (totalFiles === 0) {
        setStatus('');
        toastr.error('No chats found for any character. Check console (F12).');
        return;
    }

    setStatus('Generating zip file...');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const ts = getTimestamp();
    downloadBlob(blob, `all_chats_backup_${ts}.zip`);
    setStatus('');
    toastr.success(`Downloaded ${totalFiles} chats from ${totalChars} characters as .zip`);
}

// ─── UI ───

function createUI() {
    const hasFolderPicker = supportsDirectoryPicker();
    const modeNotice = hasFolderPicker
        ? '💻 <b>Desktop mode:</b> Choose a folder to save files directly, or skip to download as .zip.'
        : '📱 <b>Mobile/Firefox mode:</b> Folder picker not available. All bulk backups download as a single .zip file.';

    const html = `
    <div id="chat-backup-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Backup</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="backup-notice">${modeNotice}</div>

                ${hasFolderPicker ? `
                <label>Backup folder:</label>
                <div id="chat_backup_folder_display">No folder selected</div>
                <div class="menu_button" id="chat_backup_pick_folder">
                    <i class="fa-solid fa-folder-open"></i>
                    <span>Choose Folder</span>
                </div>
                <small class="backup-info">Folder access lasts for this session. Re-select after restarting ST.</small>
                ` : `<div id="chat_backup_folder_display" style="display:none"></div>`}

                <label style="margin-top:8px;">
                    <input id="chat_backup_timestamp" type="checkbox" />
                    Include timestamp in filename
                </label>

                <hr>

                <div class="menu_button" id="chat_backup_btn">
                    <i class="fa-solid fa-download"></i>
                    <span>Backup Current Chat</span>
                </div>
                <div class="menu_button" id="chat_backup_all_btn">
                    <i class="fa-solid fa-box-archive"></i>
                    <span>Backup All Chats (Current Character)${!hasFolderPicker ? ' → .zip' : ''}</span>
                </div>
                <div class="menu_button" id="chat_backup_everything_btn">
                    <i class="fa-solid fa-cloud-arrow-down"></i>
                    <span>Backup Everything (All Characters)${!hasFolderPicker ? ' → .zip' : ''}</span>
                </div>

                <small id="chat_backup_status" class="backup-status"></small>
            </div>
        </div>
    </div>`;

    const container = document.getElementById('extensions_settings2');
    if (!container) { console.error(`[${MODULE_NAME}] #extensions_settings2 not found`); return; }
    container.insertAdjacentHTML('beforeend', html);

    const settings = getSettings();

    if (hasFolderPicker) {
        document.getElementById('chat_backup_pick_folder').addEventListener('click', pickFolder);
    }

    const cb = document.getElementById('chat_backup_timestamp');
    cb.checked = settings.includeTimestamp;
    cb.addEventListener('change', (e) => {
        settings.includeTimestamp = e.target.checked;
        saveSettingsDebounced();
    });

    document.getElementById('chat_backup_btn').addEventListener('click', backupCurrentChat);
    document.getElementById('chat_backup_all_btn').addEventListener('click', backupCurrentCharAllChats);
    document.getElementById('chat_backup_everything_btn').addEventListener('click', backupEverything);

    updateFolderDisplay();
}

createUI();
console.log(`[${MODULE_NAME}] v1.7 loaded. Folder picker: ${supportsDirectoryPicker()}`);
