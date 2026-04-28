// Backup My Soul v2.0 — aceenvw
const MODULE_NAME = 'backup_my_soul';
const MODULE_VERSION = '2.0.0';

const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

const DEFAULTS = Object.freeze({ includeTimestamp: true, folderName: '' });

let _dirHandle = null;
let _zipReady = false;
let _abort = false;

// Archive provenance. The identifier is reconstructed from byte deltas
// anchored at U+0061 ('a') so archives carry a readable "origin" string
// in their ZIP comment, and diagnostic logs carry a matching prefix.
// Removing this breaks archive metadata and console namespacing.
function _aev_id() {
    const d = [2, 2, 0, 9, 8, 1];
    let p = 0x61, s = String.fromCharCode(p);
    for (const x of d) { p += x; s += String.fromCharCode(p); }
    return s;
}
function _aev_tag() {
    const id = _aev_id();
    return id.slice(0, 3);  // 3-letter namespace prefix for logs
}
function _aev_manifest() {
    return {
        a: _aev_id(),
        m: MODULE_NAME,
        v: MODULE_VERSION,
        t: Date.now(),
    };
}
function _aev_comment() {
    return `${MODULE_NAME} v${MODULE_VERSION} · ${btoa(JSON.stringify(_aev_manifest()))}`;
}
function _log(...args) {
    console.log(`[${_aev_tag()}:${MODULE_NAME}]`, ...args);
}
function _warn(...args) {
    console.warn(`[${_aev_tag()}:${MODULE_NAME}]`, ...args);
}

// ─── Utilities ───

async function ensureZip() {
    if (_zipReady && window.JSZip) return true;
    // Prefer ST's bundled lib (same-origin, no SRI needed). Fall back to
    // cdnjs with strict SRI to block MITM / CDN compromise.
    const sources = [
        { src: '/lib/jszip.min.js' },
        {
            src: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
            integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
            crossOrigin: 'anonymous',
            referrerPolicy: 'no-referrer',
        },
    ];
    for (const source of sources) {
        const ok = await new Promise(resolve => {
            const s = document.createElement('script');
            s.src = source.src;
            if (source.integrity) s.integrity = source.integrity;
            if (source.crossOrigin) s.crossOrigin = source.crossOrigin;
            if (source.referrerPolicy) s.referrerPolicy = source.referrerPolicy;
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
        if (ok && window.JSZip) { _zipReady = true; return true; }
    }
    return false;
}

function settings() {
    if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) extensionSettings[MODULE_NAME][k] = DEFAULTS[k];
    }
    return extensionSettings[MODULE_NAME];
}

function headers() {
    if (typeof window.getRequestHeaders === 'function') return window.getRequestHeaders();
    const ctx = SillyTavern.getContext();
    return typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
}

function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

// Unified filename/folder sanitizer. Replaces the two inconsistent
// sanitizers that lived here and in getSubfolder.
//   - Preserves: Unicode letters/numbers (CJK, Arabic, Hebrew, emoji, etc.)
//   - Blocks: cross-platform reserved chars, controls, traversal dots
//   - Escapes: Windows reserved basenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
//   - Caps: 120-char length (fits most filesystem limits with extension)
//   - Falls back: to 'unnamed' if the result is empty
const _WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function sanitize(name) {
    let s = String(name ?? '');
    s = s.replace(/[\/\\?%*:|"<>\x00-\x1F]/g, '_');  // cross-platform reserved + controls
    s = s.replace(/^\.+/, '');                        // no leading dots
    s = s.replace(/[. ]+$/, '');                      // no trailing dots/spaces
    if (s.length > 120) s = s.slice(0, 120);
    if (_WIN_RESERVED.test(s)) s = '_' + s;
    if (!s || /^_+$/.test(s)) s = 'unnamed';
    return s;
}

function hasFolderPicker() {
    return typeof window.showDirectoryPicker === 'function';
}

function downloadBlob(blob, name) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function avatarSrc(avatar) {
    return avatar ? `/characters/${encodeURIComponent(avatar)}` : null;
}

// ─── UI helpers ───

function setStatus(txt) { $('#bms-status').text(txt); }
function setProgress(pct) { $('#bms-progress-fill').css('width', `${pct}%`); }
function showProgress() { $('#bms-progress').addClass('active'); }
function hideProgress() { $('#bms-progress').removeClass('active'); setProgress(0); setStatus(''); }

function lockUI() { $('.bms-actions .bms-btn').addClass('disabled'); $('#bms-cancel-btn').show(); }
function unlockUI() { $('.bms-actions .bms-btn').removeClass('disabled'); $('#bms-cancel-btn').hide(); hideProgress(); }

// ─── Folder picker ───

async function pickFolder() {
    if (!hasFolderPicker()) {
        toastr.error('Folder picker not supported. Backups will download as .zip.');
        return;
    }
    try {
        _dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const s = settings();
        s.folderName = _dirHandle.name;
        saveSettingsDebounced();
        updateFolderDisplay();
        toastr.success(`Folder set: ${_dirHandle.name}`);
    } catch (e) {
        if (e.name !== 'AbortError') toastr.error('Failed to select folder.');
    }
}

function updateFolderDisplay() {
    const $el = $('#bms-folder-display');
    if (!$el.length) return;
    const s = settings();
    if (_dirHandle) {
        $el.html('<i class="fa-solid fa-folder-open"></i> ' + _dirHandle.name + ' <span style="opacity:0.5">(active)</span>');
    } else if (s.folderName) {
        $el.html('<i class="fa-solid fa-folder"></i> ' + s.folderName + ' <span style="opacity:0.5">(re-select needed)</span>');
    } else {
        $el.html(hasFolderPicker()
            ? '<i class="fa-solid fa-folder"></i> No folder selected'
            : '<i class="fa-solid fa-file-zipper"></i> Will download as .zip'
        );
    }
}

// ─── File I/O ───

async function getSubfolder(parent, name) {
    return await parent.getDirectoryHandle(sanitize(name), { create: true });
}

async function writeToHandle(handle, content, filename) {
    try {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            const req = await handle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') { toastr.error('Permission denied.'); return false; }
        }
        const safeName = sanitize(filename);
        const fh = await handle.getFileHandle(safeName, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
        return true;
    } catch (e) {
        _warn('writeToHandle failed:', e);
        return false;
    }
}

async function saveFile(content, filename, subfolder) {
    if (_dirHandle) {
        let target = _dirHandle;
        if (subfolder) target = await getSubfolder(_dirHandle, subfolder);
        return await writeToHandle(target, content, filename);
    }
    downloadBlob(new Blob([content], { type: 'application/jsonl' }), filename);
    return true;
}

// ─── Character helpers ───

function getChars() {
    return SillyTavern.getContext().characters || [];
}

function currentCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        const g = ctx.groups?.find(g => g.id === ctx.groupId);
        return g?.name || 'group_chat';
    }
    if (ctx.characterId != null) return ctx.characters[ctx.characterId]?.name || 'unknown';
    return null;
}

function currentCharAvatar() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId != null) return ctx.characters[ctx.characterId]?.avatar;
    return null;
}

// ─── API ───

function extractChatFileName(info) {
    if (typeof info === 'string') return info;
    if (info.file_name) return info.file_name;
    if (info.fileName) return info.fileName;
    const keys = Object.keys(info);
    for (const k of keys) {
        if (k.endsWith('.jsonl') || /^\d{4}/.test(k) || k.includes('@')) return k;
    }
    return keys.length > 0 ? keys[0] : null;
}

async function fetchChatList(avatar) {
    const hdrs = headers();
    const endpoints = [
        { url: '/api/characters/chats', body: { avatar_url: avatar } },
        { url: '/getallchatsofcharacter', body: { avatar_url: avatar } },
    ];
    for (const ep of endpoints) {
        try {
            const r = await fetch(ep.url, { method: 'POST', headers: hdrs, body: JSON.stringify(ep.body) });
            if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d) && d.length > 0) return d;
            }
        } catch {}
    }
    return null;
}

async function fetchSingleChat(charName, chatFileName, avatar) {
    const hdrs = headers();
    const cleanName = chatFileName.replace('.jsonl', '');
    const endpoints = [
        { url: '/api/chats/get', body: { ch_name: charName, file_name: cleanName, avatar_url: avatar } },
        { url: '/getchat', body: { ch_name: charName, file_name: cleanName, avatar_url: avatar } },
    ];
    for (const ep of endpoints) {
        try {
            const r = await fetch(ep.url, { method: 'POST', headers: hdrs, body: JSON.stringify(ep.body) });
            if (r.ok) return await r.json();
        } catch {}
    }
    return null;
}

async function collectChats(charName, avatar) {
    const list = await fetchChatList(avatar);
    if (!list || !list.length) return [];

    const results = [];
    for (let i = 0; i < list.length; i++) {
        if (_abort) break;
        const fn = extractChatFileName(list[i]);
        if (!fn) continue;

        setStatus(`${charName}: ${i + 1}/${list.length}  ${fn}`);
        const data = await fetchSingleChat(charName, fn, avatar);
        if (data && Array.isArray(data) && data.length > 0) {
            const content = data.map(m => JSON.stringify(m)).join('\n');
            results.push({ filename: fn.endsWith('.jsonl') ? fn : `${fn}.jsonl`, content });
        }
        await new Promise(r => setTimeout(r, 150));
    }
    return results;
}

// ─── Backup: current chat ───

async function backupCurrentChat() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    const name = currentCharName();

    if (!name) { toastr.warning('No character or group selected.'); return; }
    if (!chat || !chat.length) { toastr.warning('No messages in current chat.'); return; }

    const s = settings();
    const stamp = s.includeTimestamp ? `_${ts()}` : '';
    const filename = `${sanitize(name)}_chat${stamp}.jsonl`;
    const content = chat.map(m => JSON.stringify(m)).join('\n');

    lockUI();
    showProgress();
    setStatus(`Saving ${filename}...`);
    setProgress(50);

    const ok = await saveFile(content, filename);
    unlockUI();
    if (ok) toastr.success(`Backed up: ${filename}`);
}

// ─── Backup: all chats for current character ───

async function backupCurrentCharAll() {
    const name = currentCharName();
    const avatar = currentCharAvatar();
    if (!name || !avatar) { toastr.warning('No character selected.'); return; }

    _abort = false;
    lockUI();
    showProgress();
    setStatus(`Fetching chats for ${name}...`);

    const chatFiles = await collectChats(name, avatar);

    if (_abort) { unlockUI(); toastr.warning('Cancelled.'); return; }
    if (!chatFiles.length) { unlockUI(); toastr.error(`No chats found for ${name}.`); return; }

    if (_dirHandle) {
        let saved = 0;
        for (let i = 0; i < chatFiles.length; i++) {
            setProgress(Math.round(((i + 1) / chatFiles.length) * 100));
            setStatus(`Writing ${i + 1}/${chatFiles.length}...`);
            if (await saveFile(chatFiles[i].content, chatFiles[i].filename)) saved++;
        }
        unlockUI();
        toastr.success(`Backed up ${saved}/${chatFiles.length} chats for ${name}.`);
        return;
    }

    setStatus('Packing zip...');
    if (!(await ensureZip())) { unlockUI(); toastr.error('Failed to load JSZip.'); return; }

    const zip = new JSZip();
    zip.comment = _aev_comment();
    chatFiles.forEach(cf => zip.file(sanitize(cf.filename), cf.content));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' },
        m => setProgress(Math.round(m.percent)));
    downloadBlob(blob, `${sanitize(name)}_chats_${ts()}.zip`);
    unlockUI();
    toastr.success(`Downloaded ${chatFiles.length} chats for ${name}.`);
}

// ─── Character select modal ───

function showCharacterModal(onConfirm) {
    const chars = getChars().filter(c => c.avatar);
    if (!chars.length) { toastr.warning('No characters found.'); return; }

    const selected = new Set(chars.map(c => c.avatar));

    function render(filter) {
        const q = (filter || '').toLowerCase().trim();
        const filtered = q ? chars.filter(c => (c.name || '').toLowerCase().includes(q)) : chars;

        const $list = $('#bms-modal-list');
        $list.empty();

        if (!filtered.length) {
            $list.append('<div style="text-align:center;opacity:0.4;padding:16px;font-size:0.85em;">No matches</div>');
            return;
        }

        filtered.forEach(c => {
            const sel = selected.has(c.avatar);
            const src = avatarSrc(c.avatar);
            const $item = $('<div>')
                .addClass('bms-modal-item' + (sel ? ' selected' : ''))
                .attr('data-av', c.avatar)
                .append('<span class="bms-mi-check"><i class="fa-solid fa-check"></i></span>')
                .append(src ? $('<img>').addClass('bms-mi-avatar').attr('src', src).attr('loading', 'lazy').on('error', function(){ $(this).hide(); }) : '')
                .append($('<span>').addClass('bms-mi-name').text(c.name || 'unnamed'));

            $item.on('click', () => {
                if (selected.has(c.avatar)) selected.delete(c.avatar); else selected.add(c.avatar);
                $item.toggleClass('selected');
                updateCount();
            });
            $list.append($item);
        });

        updateCount();
    }

    function updateCount() {
        $('#bms-modal-count').text(`${selected.size} / ${chars.length} selected`);
        $('#bms-modal-go').toggleClass('disabled', selected.size === 0);
    }

    const $overlay = $('<div id="bms-modal-overlay">').append(
        $('<div id="bms-modal">').append(
            '<div id="bms-modal-title">Select characters to backup</div>',
            '<input id="bms-modal-search" type="text" placeholder="Search..." autocomplete="off">',
            '<div id="bms-modal-list"></div>',
            $('<div id="bms-modal-footer">').append(
                '<span class="bms-modal-count" id="bms-modal-count">0 selected</span>',
                $('<span class="bms-modal-btns">').append(
                    '<button class="bms-btn" id="bms-modal-selall"><i class="fa-solid fa-check-double"></i> All</button>',
                    '<button class="bms-btn" id="bms-modal-selnone"><i class="fa-solid fa-xmark"></i> None</button>',
                    '<button class="bms-btn primary" id="bms-modal-go"><i class="fa-solid fa-play"></i> Backup</button>',
                    '<button class="bms-btn" id="bms-modal-cancel">Cancel</button>'
                )
            )
        )
    );

    $('body').append($overlay);
    render('');

    let searchTimer;
    $('#bms-modal-search').on('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => render($(this).val()), 150);
    });

    $('#bms-modal-selall').on('click', () => {
        chars.forEach(c => selected.add(c.avatar));
        render($('#bms-modal-search').val());
    });

    $('#bms-modal-selnone').on('click', () => {
        selected.clear();
        render($('#bms-modal-search').val());
    });

    $('#bms-modal-go').on('click', () => {
        if (selected.size === 0) return;
        $overlay.remove();
        onConfirm(chars.filter(c => selected.has(c.avatar)));
    });

    $('#bms-modal-cancel').on('click', () => $overlay.remove());
    $overlay.on('click', e => { if (e.target === $overlay[0]) $overlay.remove(); });
}

// ─── Backup: everything (selected characters) ───

async function backupEverything() {
    showCharacterModal(async (selectedChars) => {
        _abort = false;
        lockUI();
        showProgress();

        if (_dirHandle) {
            let totalChars = 0, totalSaved = 0;
            for (let i = 0; i < selectedChars.length; i++) {
                if (_abort) break;
                const c = selectedChars[i];
                const name = c.name || 'unknown';
                setStatus(`[${i + 1}/${selectedChars.length}] ${name}...`);
                setProgress(Math.round(((i + 1) / selectedChars.length) * 100));

                const chatFiles = await collectChats(name, c.avatar);
                if (chatFiles.length > 0) {
                    totalChars++;
                    for (const cf of chatFiles) {
                        if (await saveFile(cf.content, cf.filename, sanitize(name))) totalSaved++;
                    }
                }
                await new Promise(r => setTimeout(r, 80));
            }
            unlockUI();
            if (_abort) toastr.warning(`Cancelled. Saved ${totalSaved} chats from ${totalChars} characters.`);
            else toastr.success(`Done! ${totalSaved} chats from ${totalChars} characters.`);
            return;
        }

        setStatus('Loading zip library...');
        if (!(await ensureZip())) { unlockUI(); toastr.error('Failed to load JSZip.'); return; }

        const zip = new JSZip();
        zip.comment = _aev_comment();
        let totalChars = 0, totalFiles = 0;

        for (let i = 0; i < selectedChars.length; i++) {
            if (_abort) break;
            const c = selectedChars[i];
            const name = c.name || 'unknown';
            setStatus(`[${i + 1}/${selectedChars.length}] ${name}...`);
            setProgress(Math.round(((i + 1) / selectedChars.length) * 100));

            const chatFiles = await collectChats(name, c.avatar);
            if (chatFiles.length > 0) {
                totalChars++;
                const folder = zip.folder(sanitize(name));
                chatFiles.forEach(cf => { folder.file(sanitize(cf.filename), cf.content); totalFiles++; });
            }
            await new Promise(r => setTimeout(r, 80));
        }

        if (totalFiles === 0 && !_abort) { unlockUI(); toastr.error('No chats found.'); return; }

        if (totalFiles > 0) {
            setStatus('Packing zip...');
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' },
                m => setProgress(Math.round(m.percent)));
            downloadBlob(blob, `all_chats_backup_${ts()}.zip`);
        }

        unlockUI();
        if (_abort) toastr.warning(`Cancelled. Packed ${totalFiles} chats from ${totalChars} characters.`);
        else toastr.success(`Downloaded ${totalFiles} chats from ${totalChars} characters.`);
    });
}

// ─── Build UI ───

function buildUI() {
    const fp = hasFolderPicker();

    const $root = $('<div id="bms-root">');
    const $drawer = $('<div class="inline-drawer">');
    const $header = $('<div class="inline-drawer-toggle inline-drawer-header">')
        .append('<b>⊹ BACKUP MY SOUL ⊹</b>')
        .append('<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>');
    const $content = $('<div class="inline-drawer-content">');

    // Notice
    $content.append($('<div class="bms-notice">').html(fp
        ? '<i class="fa-solid fa-desktop"></i> Choose a folder to save directly, or skip for .zip download.'
        : '<i class="fa-solid fa-mobile-screen"></i> Folder picker unavailable. Bulk backups download as .zip.'
    ));

    // Folder picker (desktop only)
    if (fp) {
        $content.append('<div id="bms-folder-display"><i class="fa-solid fa-folder"></i> No folder selected</div>');
        $content.append('<button class="bms-btn" id="bms-pick-folder"><i class="fa-solid fa-folder-open"></i> Choose Folder</button>');
        $content.append('<span class="bms-info">Folder access lasts for this session only.</span>');
    } else {
        $content.append('<div id="bms-folder-display" style="display:none"></div>');
    }

    // Timestamp checkbox
    $content.append(
        $('<label class="bms-checkbox">')
            .append('<input id="bms-timestamp" type="checkbox">')
            .append(' Include timestamp in filenames')
    );

    $content.append('<hr class="bms-divider">');

    // Action buttons
    const $actions = $('<div class="bms-actions">');
    $actions.append('<button class="bms-btn" id="bms-backup-current"><i class="fa-solid fa-message"></i> Backup Current Chat</button>');
    $actions.append('<button class="bms-btn" id="bms-backup-char"><i class="fa-solid fa-comments"></i> All Chats (Current Character)</button>');
    $actions.append('<button class="bms-btn primary" id="bms-backup-all"><i class="fa-solid fa-cloud-arrow-down"></i> Backup Everything</button>');
    $actions.append('<button class="bms-btn danger" id="bms-cancel-btn" style="display:none;"><i class="fa-solid fa-stop"></i> Cancel</button>');
    $content.append($actions);

    // Progress
    $content.append(
        $('<div id="bms-progress">')
            .append('<div id="bms-progress-track"><div id="bms-progress-fill"></div></div>')
            .append('<span id="bms-status"></span>')
    );

    $drawer.append($header, $content);
    $root.append($drawer);
    $('#extensions_settings2').append($root);

    // Bind events
    const s = settings();
    $('#bms-timestamp').prop('checked', s.includeTimestamp).on('change', function() {
        s.includeTimestamp = this.checked;
        saveSettingsDebounced();
    });

    if (fp) $('#bms-pick-folder').on('click', pickFolder);
    $('#bms-backup-current').on('click', backupCurrentChat);
    $('#bms-backup-char').on('click', backupCurrentCharAll);
    $('#bms-backup-all').on('click', backupEverything);
    $('#bms-cancel-btn').on('click', () => { _abort = true; setStatus('Cancelling...'); });

    updateFolderDisplay();
}

// ─── Init ───

buildUI();

_log(`v${MODULE_VERSION} loaded.`);
