// ==UserScript==
// @name         Gmail Attachment Batch - prototype
// @namespace    local.gmail-attachment-batch
// @author       Paul Wood FRSA (paultendo)
// @license      GPL-3.0-only
// @homepageURL  https://github.com/paultendo/gmail-attachment-batch
// @supportURL   https://github.com/paultendo/gmail-attachment-batch/issues
// @updateURL    https://raw.githubusercontent.com/paultendo/gmail-attachment-batch/main/gmail-attachment-batch.user.js
// @downloadURL  https://raw.githubusercontent.com/paultendo/gmail-attachment-batch/main/gmail-attachment-batch.user.js
// @version      0.4.5
// @description  Review a Gmail search, capture its result conversations, then save their attachments in a batch.
// @match        https://mail.google.com/mail/*
// @run-at       document-idle
// @noframes
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @connect      mail.google.com
// @connect      mail-attachment.googleusercontent.com
// ==/UserScript==
// Copyright (c) 2026 Paul Wood FRSA.
// GPL-3.0-only with the author-attribution term permitted by section 7(b).
// Full licence and ATTRIBUTION.md notice are included at the end of this file.
// This program is free software, distributed without any warranty.

(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') api.mount(window);
})(function () {
  'use strict';
  const REPOSITORY_URL = 'https://github.com/paultendo/gmail-attachment-batch';
  const AUTHOR_URL = 'https://github.com/paultendo';
  const COFFEE_URL = 'https://buymeacoffee.com/paultendo';
  const HOSTS = new Set(['mail.google.com', 'mail-attachment.googleusercontent.com']);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const cssEscape = value => String(value).replace(/["\\]/g, '\\$&');

  function shown(el) {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || node.style?.display === 'none') return false;
    }
    return true;
  }

  function accountRoot(href) {
    const url = new URL(href);
    const match = url.pathname.match(/^\/mail\/(?:u\/\d+\/)?/);
    if (!match || url.hostname !== 'mail.google.com') throw new Error('Open Gmail in Chrome first.');
    return url.origin + match[0];
  }

  function searchState(href) {
    const url = new URL(href);
    const match = url.hash.match(/^#search\/([^/]+)(?:\/p(\d+))?$/);
    if (!match) throw new Error('Run a Gmail search and return to its results list before capturing.');
    let query;
    try { query = decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch { throw new Error('Gmail search URL could not be read.'); }
    if (!query.trim()) throw new Error('Enter a search first.');
    return { root: accountRoot(href), query, baseHash: '#search/' + match[1], originalHash: url.hash, page: Number(match[2] || 1) };
  }

  function mainPane(doc) {
    return [...doc.querySelectorAll('[role="main"]')].find(shown) || null;
  }

  function rowReference(row) {
    const node = row.matches('[data-legacy-thread-id],[data-legacy-message-id],[data-thread-id]')
      ? row : row.querySelector('[data-legacy-thread-id],[data-legacy-message-id],[data-thread-id]');
    let id = node?.getAttribute('data-legacy-thread-id');
    let kind = 'thread';
    if (!id) { id = node?.getAttribute('data-legacy-message-id'); kind = 'message'; }
    if (!id) {
      const decimal = node?.getAttribute('data-thread-id')?.match(/^#?thread-[fa]:(\d+)(?:\||$)/)?.[1];
      if (decimal) { id = BigInt(decimal).toString(16); kind = 'thread'; }
    }
    if (!id || !/^[a-f0-9]{8,32}$/i.test(id)) throw new Error('A Gmail result has no recognisable message/thread ID. Capture stopped; no partial batch will run.');
    const sender = row.querySelector('[email]');
    const subject = text(row.querySelector('.bog')) || text(row.querySelector('[role="link"]')) || text(row).slice(0, 180);
    const dateNode = row.querySelector('td.xW [title],td.xW [data-tooltip],td.xW');
    const date = dateNode?.getAttribute('title') || dateNode?.getAttribute('data-tooltip') || text(dateNode);
    return { id, kind, hash: '#all/' + id, subject, sender: sender?.getAttribute('email') || text(sender), date, selected: true };
  }

  function resultRows(doc) {
    const main = mainPane(doc);
    if (!main) throw new Error('Gmail has not finished loading its main view.');
    const rows = [...main.querySelectorAll('tr.zA[role="row"],tr.zA,[role="row"][data-legacy-thread-id]')].filter(shown);
    const refs = rows.map(rowReference);
    return [...new Map(refs.map(ref => [ref.kind + ':' + ref.id, ref])).values()];
  }

  function control(doc, pattern) {
    return [...doc.querySelectorAll('[role="button"],button')].find(el => {
      if (!shown(el) || el.closest('.a3s')) return false;
      const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
      return pattern.test(label.trim());
    });
  }

  function enabled(el) {
    return !!el && !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
  }

  function utf8Clip(value, maxBytes) {
    let result = '', bytes = 0;
    for (const char of value) { const size = new TextEncoder().encode(char).length; if (bytes + size > maxBytes) break; result += char; bytes += size; }
    return result;
  }
  function safeFolder(value, maxBytes = 64, fallback = 'Untitled') {
    let clean = String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g,'_').replace(/\s+/g,' ').replace(/^\.+/,'').replace(/[. ]+$/,'').trim();
    clean = utf8Clip(clean, maxBytes).replace(/[. ]+$/,'') || fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
    return clean;
  }
  function batchFolderName(query, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}_${safeFolder(query,32,'Search').replace(/ /g,'-')}`;
  }
  function attachmentPath(folder, layout, ref, file, index) {
    const batch = safeFolder(folder,64,'Gmail batch');
    const threadId = safeFolder(ref.id,32,'thread');
    const thread = safeFolder(ref.subject,40,'Untitled thread') + '_' + threadId;
    const filename = `${String(index + 1).padStart(3,'0')}_${safeFilename(file.filename,70)}`;
    return ['Gmail attachments',batch,...(layout === 'flat' ? [] : [thread]),...(layout === 'flat' ? [threadId + '_' + filename] : [filename])].join('/');
  }

  function safeFilename(name, maxBaseBytes = 95) {
    const clean = String(name).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
    if (!clean) throw new Error('Attachment has no usable filename.');
    const extension = clean.match(/\.[a-z0-9]{1,12}$/i)?.[0] || '';
    let base = extension ? clean.slice(0, -extension.length) : clean;
    base = utf8Clip(base, maxBaseBytes).replace(/[. ]+$/, "") || "attachment";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
    return base + extension;
  }

  function attachmentUrl(raw, root) {
    const candidates = String(raw || '').match(/https:\/\/[^\s]+/g) || [];
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate);
        if (!HOSTS.has(url.hostname) || url.username || url.password) continue;
        if (url.hostname === 'mail.google.com') {
          if (url.searchParams.get('view') !== 'att') continue;
          const expected = new URL(root).pathname.match(/\/u\/(\d+)/)?.[1];
          const actual = url.pathname.match(/\/u\/(\d+)/)?.[1];
          if (expected && actual && expected !== actual) throw new Error('Attachment points to another Gmail account.');
        }
        return url;
      } catch (error) {
        if (error.message === 'Attachment points to another Gmail account.') throw error;
      }
    }
    throw new Error('No supported Gmail attachment download URL is exposed for this tile.');
  }

  function collectAttachments(doc, ref, root) {
    const main = mainPane(doc);
    if (!main) throw new Error('Gmail message view is unavailable.');
    const tiles = [...new Set([...main.querySelectorAll('.aQH span.aZo,.aQH [download_url]')])].filter(el => shown(el) && !el.closest('.a3s'));
    const files = [], issues = [];
    tiles.forEach((tile, index) => {
      const filename = text(tile.querySelector('.aV3')) || tile.getAttribute('data-filename') || '';
      try {
        const url = attachmentUrl(tile.getAttribute('download_url'), root);
        const owner = tile.closest('[data-legacy-message-id],[data-message-id]');
        const messageId = url.searchParams.get('th') || url.searchParams.get('permmsgid') || owner?.getAttribute('data-legacy-message-id') || owner?.getAttribute('data-message-id') || ref.id;
        const partId = url.searchParams.get('realattid') || url.searchParams.get('attid');
        const key = JSON.stringify([messageId, partId || `tile-${index}`, filename]);
        files.push({ key, messageId, filename: filename || `attachment-${index + 1}`, safeName: safeFilename(filename), url: url.href });
      } catch (error) { issues.push({ filename: filename || '(unnamed tile)', message: error.message }); }
    });
    const cloud = [...main.querySelectorAll('.aQH a[href]')].filter(a => {
      if (a.closest('.a3s') || !shown(a)) return false;
      try { return ['drive.google.com', 'docs.google.com'].includes(new URL(a.href).hostname); } catch { return false; }
    });
    if (cloud.length) issues.push({ filename: '(cloud links)', message: 'Drive links are not ordinary Gmail attachments and were not downloaded.' });
    return { files: [...new Map(files.map(file => [file.key, file])).values()], issues };
  }

  function isExpectedThread(doc, ref) {
    const main = mainPane(doc);
    if (!main) return false;
    const header = [...main.querySelectorAll('h2[data-legacy-thread-id]')].find(el => !el.closest('.a3s'));
    if (ref.kind === 'thread') return shown(header) && header.getAttribute('data-legacy-thread-id') === ref.id;
    return [...main.querySelectorAll('[data-legacy-message-id]')].some(el => shown(el) && !el.closest('.a3s') && el.getAttribute('data-legacy-message-id') === ref.id);
  }

  function csvCell(value) {
    let s = String(value ?? '');
    if (/^\s*[=+@\-\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }

  function reportCsv(state) {
    const fields = ['query', 'scope', 'subject', 'result_id', 'message_id', 'attachment_key', 'filename', 'requested_name', 'status', 'detail', 'time'];
    const rows = [...state.log];
    const attempted = new Set(rows.map(row => row.attachment_key).filter(Boolean));
    for (const [key, row] of state.planned || []) if (!attempted.has(key)) rows.push(row);
    for (const ref of state.snapshot?.refs || []) {
      if (ref.selected && !state.visited?.has(ref.id)) rows.push({ subject: ref.subject, result_id: ref.id, status: 'not_processed', detail: 'Captured conversation was not opened successfully in this batch.' });
    }
    return '\uFEFF' + [fields.map(csvCell).join(','), ...rows.map(row => fields.map(k => csvCell(k === 'query' ? state.snapshot?.query : k === 'scope' ? 'All messages in captured result conversations' : row[k])).join(','))].join('\r\n');
  }

  async function waitFor(probe, guard, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      guard();
      const value = probe();
      if (value) return value;
      await sleep(160);
    }
    throw new Error('Gmail did not reach the expected view in time. Nothing from the unverified view was downloaded.');
  }

  function downloadOne(download, file, name, onHandle, timeout = 180000) {
    return new Promise((resolve, reject) => {
      let done = false, handle;
      const finish = (error) => {
        if (done) return;
        done = true; clearTimeout(timer); onHandle(null);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error('No completion callback; check Chrome Downloads before retrying.');
        error.unknown = true;
        finish(error); handle?.abort?.();
      }, timeout);
      try {
        handle = download({ url: file.url, name, saveAs: false, conflictAction: 'uniquify',
          onload: () => finish(),
          onerror: result => { const error = new Error(result?.error || 'Download failed or was cancelled.'); error.code = result?.error; finish(error); },
          ontimeout: () => { const error = new Error('Download timed out; check Chrome Downloads.'); error.unknown = true; finish(error); handle?.abort?.(); },
        });
        if (!done) onHandle({ abort() {
          const error = new Error('Stopped during a download; check Chrome Downloads before retrying this file.');
          error.unknown = true; finish(error); handle?.abort?.();
        } });
      } catch (error) { finish(error); }
    });
  }

  function mount(win) {
    const demo = win.__GMAIL_BATCH_DEMO__ === true;
    if (!demo && win.location.hostname !== 'mail.google.com') return;
    const doc = win.document;
    if (doc.getElementById('gmail-attachment-batch-host')) return;
    const state = { phase: 'idle', message: 'Search in Gmail, then capture the results.', snapshot: null, log: [], done: new Set(), unknown: new Set(), planned: new Map(), visited: new Set(), paused: false, stopped: false, busy: false, processed: 0, handle: null, expectedHash: null, expanded: false, reviewQuery: '', reviewSelection: 'all', reviewSort: 'captured', reviewPage: 1, reportSaving: false, checkingSetup: false, setupTone: null, setupMessage: null };
    const host = doc.createElement('div'); host.id = 'gmail-attachment-batch-host'; doc.documentElement.append(host);
    const shadow = host.attachShadow({mode: 'open'});
    // Gmail enforces Trusted Types. Build every node directly: no HTML sinks,
    // policy overrides, remote code or email text passed through an HTML parser.
    const h = (tag, attrs = {}, ...children) => {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== false && value != null) node.setAttribute(key, value === true ? '' : String(value));
      }
      children.flat(Infinity).filter(value => value != null).forEach(child => {
        node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
      });
      return node;
    };
    const style = doc.createElement('style');
    style.textContent = "\n:host{all:initial;font:13px/1.5 \"Google Sans\",Roboto,Arial,sans-serif;color:#1f1f1f;color-scheme:light}*{box-sizing:border-box}\n[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer;transition:background-color .15s,box-shadow .15s}button:disabled{cursor:default;background:#f1f3f4!important;color:#80868b!important;border-color:transparent!important;box-shadow:none!important}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #0b57d0;outline-offset:3px}::selection{background:#c2e7ff;color:#001d35}\n#panel{position:fixed;right:24px;bottom:24px;width:420px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 48px);overflow:auto;z-index:2147483647;background:#fff;box-shadow:0 4px 24px #3c404340,0 1px 3px #3c404333;border-radius:16px;scrollbar-width:thin;scrollbar-color:#bdc1c6 transparent}\nheader{padding:20px 24px 16px;position:relative;background:#f2f6fc;border-radius:16px 16px 0 0}h1{font-size:20px;line-height:28px;font-weight:500;margin:0 32px 4px 0}header .small{margin:0;max-width:320px}.pad{padding:4px 24px 20px}\n#close{position:absolute;right:12px;top:12px;width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:#444746;font-size:0}#close:before,#close:after{content:\"\";position:absolute;left:10px;top:17px;width:16px;height:2px;background:currentColor;transform:rotate(45deg)}#close:after{transform:rotate(-45deg)}#close:hover{background:#e2e7ef}\np{margin:8px 0 12px}.small{font-size:12px;line-height:18px;color:#5f6368}label{display:block;margin:16px 0 12px;font-size:13px;font-weight:500}select{display:block;width:100%;margin-top:6px;background:#fff;color:#202124;border:1px solid #747775;padding:9px 12px;border-radius:4px;min-height:40px}\n.button{border:1px solid transparent;border-radius:20px;background:#0b57d0;color:#fff;padding:8px 16px;font-weight:500;min-height:36px}.button:hover{background:#084fc4;box-shadow:0 1px 2px #3c40434d}.secondary{background:#fff;color:#0b57d0;border-color:#747775}.secondary:hover{background:#f0f6ff}.quiet{border-color:#c4c7c5}.danger{color:#b3261e;background:#fff;border-color:#c4c7c5}.danger:hover{background:#fceeee}\n.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}#scope{font-size:12px;line-height:18px;color:#444746;white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f6fc;padding:10px 12px;border-radius:8px;margin:16px 0 12px}.selection{display:flex;align-items:baseline;gap:4px}#count{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums}#selection{font-size:12px}\n#rows{max-height:170px;overflow:auto;border-block:1px solid #e1e3e1;margin:10px 0 12px;scrollbar-width:thin;scrollbar-color:#bdc1c6 transparent}#rows label{display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid #e8eaed;margin:0;padding:12px 0;font-size:13px;font-weight:400}#rows label:last-child{border-bottom:0}#rows input{accent-color:#0b57d0;flex:none;margin:3px 0;width:16px;height:16px}#rows span{white-space:pre-line;overflow-wrap:anywhere}\nprogress{accent-color:#0b57d0;width:100%;height:6px}#status{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}#status.error{color:#b3261e}#download{flex:1}footer{border-top:1px solid #e1e3e1;padding:12px 24px 16px;background:#fff}footer .small{margin:8px 0 0;font-size:11px;line-height:16px}a{color:#0b57d0}.demo{background:#e8f0fe;color:#174ea6;padding:8px 24px;font-size:12px}\n@media(max-width:480px){#panel{right:12px;bottom:12px;max-height:calc(100dvh - 24px)}header{padding:16px 20px}.pad{padding:4px 20px 16px}footer{padding:12px 20px}.actions{gap:6px}.button{padding:8px 12px}}\n\n#panel.expanded{inset:32px;width:auto;max-width:1440px;max-height:calc(100dvh - 64px);margin:auto;bottom:auto}.expanded header{position:sticky;top:0;z-index:2}.expanded .pad{padding-top:12px}.expanded #preview{margin-top:16px}.review-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0}.table-tools{display:none;gap:12px;align-items:end;flex-wrap:wrap;margin:12px 0}.expanded .table-tools{display:flex}.table-tools label{margin:0;font-weight:400}.table-tools input,.table-tools select{font:inherit;border:1px solid #747775;border-radius:4px;background:#fff;color:#202124;padding:8px 12px;min-height:36px;margin-top:4px}.table-tools .filter{flex:1;min-width:180px}.filter input{width:100%}.expanded #rows{max-height:48dvh}.review-table{border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed}.review-table th{position:sticky;top:0;z-index:1;background:#f2f6fc;text-align:left;font-weight:500;color:#444746}.review-table th,.review-table td{padding:10px 12px;border-bottom:1px solid #e8eaed;vertical-align:top;overflow-wrap:anywhere}.review-table th:first-child,.review-table td:first-child{width:44px}.review-table th:nth-child(2){width:46%}.review-table th:nth-child(3){width:30%}.review-table th:nth-child(4){width:20%}.review-table input{margin:2px 0!important}.review-table tr:hover td{background:#f6f8fc}.review-table tr.selected td{background:#edf3fe}#panel:not(.expanded) .review-table .detail{display:none}#panel:not(.expanded) .review-table th:nth-child(2){width:auto}.table-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:#5f6368;margin:8px 0 12px}.table-nav .actions{margin:0}#scope{margin-bottom:8px}.expanded #scope{margin-top:8px}.expanded .capture-controls{display:flex;gap:16px;align-items:end}.expanded .capture-controls label{flex:1;margin:0}.expanded .capture-controls #capture{margin-bottom:0}.expanded .capture-help{margin-top:8px}.empty{text-align:center;color:#5f6368;padding:24px!important}#panel.expanded .selection{flex-wrap:wrap}@media(max-width:700px){#panel.expanded{inset:12px;max-height:calc(100dvh - 24px)}.review-table th,.review-table td{padding:8px}.expanded .table-tools{gap:8px}.review-table .date-col{display:none}.review-table th:nth-child(2){width:55%}.review-table th:nth-child(3){width:35%}.table-nav{flex-wrap:wrap}}\n\nselect,.table-tools select{appearance:none;-webkit-appearance:none;padding-right:42px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24'%3E%3Cpath d='m7 10 5 5 5-5' fill='none' stroke='%23444746' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 12px center;background-size:20px}#review-selection{min-width:186px}#review-sort{min-width:154px}\n#panel.expanded{height:calc(100dvh - 64px);display:flex;flex-direction:column}.expanded header,.expanded footer{flex:none}.expanded .pad{display:flex;flex-direction:column;min-height:0;overflow:auto}.expanded .capture-controls,.expanded .capture-help{display:none}.expanded #preview{display:flex;flex-direction:column;min-height:0;flex:1;margin-top:0}.expanded #rows{flex:1;min-height:120px;max-height:none}.expanded .review-heading,.expanded .table-tools,.expanded .table-nav{flex:none}.expanded #status{margin-top:8px}.expanded footer{padding-block:10px}.expanded footer .small{display:none}@media(max-width:700px){#panel.expanded{height:calc(100dvh - 24px)}}\n\n.destination{display:flex;align-items:end;gap:12px;margin-top:12px;flex:none}.destination label{flex:1;min-width:0;margin:0;font-weight:400;font-size:12px}.destination input{display:block;width:100%;font:inherit;padding:9px 12px;min-height:40px;border:1px solid #747775;border-radius:4px;color:#202124;background:#fff;margin-top:6px}.destination select{font-size:12px}#destination-preview{font-size:11px;line-height:16px;margin:6px 0 0;overflow-wrap:anywhere;flex:none}.expanded .destination{margin-top:8px}.expanded .destination input,.expanded .destination select{min-height:36px;padding-block:7px}@media(max-width:480px){.destination{flex-direction:column;align-items:stretch}}\n\n#download-setup{background:#e8f0fe;border-radius:8px;padding:12px 16px;margin:12px 0;color:#174ea6;font-size:12px}#download-setup summary{font-weight:500;font-size:13px;cursor:pointer}#download-setup ol{padding-left:20px}#download-setup li{margin:6px 0}\n\n#help{position:fixed;right:24px;bottom:24px;width:560px;max-width:calc(100vw - 24px);height:620px;max-height:calc(100dvh - 48px);display:flex;flex-direction:column;z-index:2147483647;background:#fff;box-shadow:0 8px 32px #3c404340;border-radius:16px;overflow:hidden}#help header{padding:22px 24px 18px;background:#fff;flex:none}#help h1{font-size:20px;line-height:28px;margin:0 40px 0 0}#help-close{position:absolute;right:16px;top:16px;width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;color:#444746}#help-close:hover{background:#f1f3f4}.help-tabs{display:flex;padding:0 16px;background:#fff;border-bottom:1px solid #e1e3e1;flex:none}.help-tabs button{position:relative;flex:1;min-width:0;min-height:46px;padding:10px 6px;border:0;background:transparent;color:#444746;font-size:12px;font-weight:500;white-space:nowrap;border-radius:4px 4px 0 0}.help-tabs button:hover{background:#f2f6fc}.help-tabs button[aria-selected=true]{color:#0b57d0}.help-tabs button[aria-selected=true]:after{content:\"\";position:absolute;bottom:-1px;left:12px;right:12px;height:3px;border-radius:3px 3px 0 0;background:#0b57d0}.help-body{padding:24px;overflow:auto;flex:1;min-height:0;scrollbar-width:thin;scrollbar-color:#bdc1c6 transparent}.help-body h2{font-size:16px;line-height:24px;font-weight:500;margin:0 0 16px}.help-body p,.help-body li{font-size:13px;line-height:20px}.help-body .small{font-size:12px;line-height:18px}.help-body p{margin:0 0 12px}.help-body details{border-bottom:1px solid #e8eaed}.help-body summary{position:relative;list-style:none;display:flex;align-items:center;min-height:48px;padding:12px 32px 12px 0;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;color:#3c4043}.help-body summary::-webkit-details-marker{display:none}.help-body summary:after{content:\"\";position:absolute;right:8px;top:20px;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}.help-body details[open]>summary:after{top:23px;transform:rotate(225deg)}.help-body summary:hover{color:#0b57d0}.help-body details p,.help-body details ol{color:#444746;margin:0 0 16px}.help-body ol{padding-left:20px}.help-body li{margin:8px 0}.help-body a{color:#0b57d0;text-underline-offset:3px}.setup-result{display:flex;gap:14px;align-items:flex-start;background:#f2f6fc;color:#174ea6;padding:18px;border-radius:12px;margin-bottom:16px}.setup-symbol{width:36px;height:36px;display:grid;place-items:center;flex:none;border-radius:50%;background:#d3e3fd;color:#0b57d0}.setup-result h2{font-size:15px;line-height:22px;margin:0 0 4px}.setup-result p{font-size:12px;line-height:18px;margin:0;max-width:52ch}.setup-result[data-tone=success]{background:#eaf4ed;color:#185c37}.setup-result[data-tone=success] .setup-symbol{background:#cce8d5;color:#146c2e}.setup-result[data-tone=error]{background:#fceeee;color:#8c1d18}.setup-result[data-tone=error] .setup-symbol{background:#f9dedc;color:#b3261e}.setup-action{display:flex;gap:14px;align-items:center;margin:0 0 14px}.setup-action .button{flex:none}.setup-action p.small{margin:0;max-width:160px}.setup-facts{margin-top:22px;color:#5f6368}.setup-facts p{display:flex;gap:12px;align-items:flex-start;font-size:12px;line-height:18px;margin-bottom:12px}.setup-facts svg{width:18px;height:18px;flex:none;color:#5f6368}.help-steps{list-style:none;counter-reset:step;padding:0!important;margin:0 0 16px}.help-steps li{position:relative;padding:0 0 16px 40px;margin:0;counter-increment:step}.help-steps li:before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;display:grid;place-items:center;background:#f2f6fc;color:#0b57d0;border-radius:50%;font-size:12px;font-weight:500}.help-steps strong{display:block;font-size:13px;font-weight:500;margin-bottom:3px}.help-steps p{color:#5f6368;font-size:12px;line-height:18px;margin:0}.help-scope{display:flex;gap:10px;align-items:flex-start;background:#f8fafd;padding:12px;border-radius:8px;color:#444746;font-size:12px!important;margin-top:20px!important}.help-scope svg{width:18px;height:18px;flex:none}.support-link{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:44px;border-bottom:1px solid #e8eaed;text-decoration:none;font-size:13px;font-weight:500}.support-link:hover{background:#f2f6fc}.support-link svg{width:18px;height:18px}.help-support-note{margin-top:20px!important}#help footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px;flex:none;background:#fff}#help .creator-credit{max-width:220px;font-size:11px;line-height:16px}#help-page-about>.small{margin-bottom:16px}.expanded #download{flex:none;padding-inline:24px}@media(max-width:540px){#help{right:12px;bottom:12px;max-height:calc(100dvh - 24px)}#help header{padding:18px 20px}.help-tabs{padding:0 8px}.help-tabs button{font-size:11px;padding-inline:4px}.help-tabs button:nth-child(2){flex:1.1}.help-tabs button:nth-child(3){flex:1.5}.help-body{padding:20px}#help footer{padding:14px 20px}.setup-action{flex-wrap:wrap}.setup-action p.small{max-width:none}#help .creator-credit{max-width:none;width:100%}}\n\n\n.footer-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.creator-credit{font-size:11px;line-height:18px;color:#5f6368;margin:0}.creator-credit .credit-author{display:block}.creator-credit .credit-profile{display:block;white-space:nowrap}.creator-credit a{color:#0b57d0;text-decoration:underline;text-underline-offset:2px}#help header .creator-credit{margin:4px 24px 4px 0;font-size:12px}\n";
    const small = value => h('p', {class:'small'}, value);
    const downloadMode = () => typeof GM_info !== 'undefined' ? GM_info.downloadMode : demo ? 'browser' : 'unknown';
    const setupSteps = () => h('ol', {},
      h('li', {}, 'Open the Tampermonkey extension → Dashboard → Settings.'),
      h('li', {}, 'Set “Config mode” to “Advanced” to reveal the download settings.'),
      h('li', {}, 'Under “Downloads”, set “Download Mode” to “Browser API” and Save. If Chrome asks to let Tampermonkey manage downloads, choose Allow.'),
      h('li', {}, 'Refresh Gmail after saving, then open Help and choose Check download setup. You can return Config mode to Novice afterwards. Refreshing clears any captured batch; save its report first.'));
    const creatorCredit = () => h('p', {class:'creator-credit'}, h('span',{class:'credit-author'},'Created by Paul Wood FRSA'), h('span',{class:'credit-profile'},' (',h('a',{href:AUTHOR_URL,target:'_blank',rel:'noopener noreferrer'},'paultendo on GitHub'),')'));
    shadow.append(style,
      h('section', {id:'panel', 'aria-label':'Gmail attachment batch', hidden:true},
        demo ? h('div', {class:'demo'}, 'Local demo - simulated mail and downloads') : null,
        h('header', {}, h('h1', {}, 'Download attachments'), h('button', {id:'close', 'aria-label':'Close panel'}, '×'),
          small('Capture your search results, review the list, then download.')),
        h('div', {class:'pad'},
          h('details', {id:'download-setup',hidden:true},
            h('summary', {}, 'Enable folder downloads'),
            h('p', {}, 'To organise attachments into folders, change one Tampermonkey setting. You only need to do this once.'),
            setupSteps()),
          h('div', {class:'capture-controls'}, h('label', {}, 'Results to capture', h('select', {id:'pages'},
            h('option', {value:'all'}, 'All pages of this search'),
            h('option', {value:'page'}, 'This results page only'))),
          h('button', {class:'button secondary', id:'capture'}, 'Capture results')),
          h('p', {class:'small capture-help'}, 'Keep this Gmail tab open while a batch runs.'),
          h('div', {id:'scope', hidden:true}),
          h('div', {id:'preview', hidden:true},
            h('div', {class:'review-heading'}, h('div', {class:'selection'}, h('span', {id:'count'}, '0'), h('span', {class:'small',id:'selection'})), h('button', {id:'expand',class:'button secondary'}, 'Review list')),
            h('div', {class:'table-tools'},
              h('label', {class:'filter'}, 'Filter captured conversations', h('input', {id:'review-filter',type:'search',placeholder:'Search subject, sender or date'})),
              h('label', {}, 'Show', h('select', {id:'review-selection'}, h('option',{value:'all'},'All conversations'),h('option',{value:'selected'},'Selected'),h('option',{value:'excluded'},'Excluded'))),
              h('label', {}, 'Sort', h('select',{id:'review-sort'},h('option',{value:'captured'},'Gmail order'),h('option',{value:'subject'},'Subject'),h('option',{value:'sender'},'Sender'))),
              h('button', {id:'select-matching',class:'button secondary'}, 'Select matching'), h('button', {id:'exclude-matching',class:'button secondary'}, 'Exclude matching')),
            h('div', {id:'rows'}),
            h('div', {class:'table-nav'}, h('span', {id:'review-range'}), h('div', {class:'actions'}, h('button',{id:'review-prev',class:'button secondary','aria-label':'Previous review page'},'Previous'),h('button',{id:'review-next',class:'button secondary','aria-label':'Next review page'},'Next'))),
            h('p', {class:'small'}, 'Scope: attachments from ',
              h('b', {}, 'every message in each captured conversation'),
              ', including replies. Opening results may mark unread mail as read. Drive links are reported separately.')),
          h('div', {class:'destination'},
            h('label', {}, 'Folder name', h('input', {id:'folder-name',type:'text',maxlength:'180','aria-label':'Batch folder name'})),
            h('label', {}, 'Organise files', h('select', {id:'folder-layout'}, h('option',{value:'threads'},'Subfolders by thread'),h('option',{value:'flat'},'One batch folder')))),
          h('p', {id:'destination-preview',class:'small'}),
          h('div', {class:'actions'},
            h('button', {class:'button',id:'download',disabled:true}, 'Download attachments'),
            h('button', {class:'button secondary',id:'pause',disabled:true}, 'Pause'),
            h('button', {class:'button danger',id:'stop',disabled:true}, 'Stop now')),
          h('p', {id:'status',role:'status','aria-live':'polite'}),
          h('progress', {id:'progress',value:'0',max:'1',hidden:true})),
        h('footer', {}, h('div', {class:'footer-actions'}, h('button', {class:'button secondary quiet',id:'report',disabled:true}, 'Save report'), creatorCredit()),
          small('A saved file is counted only after Tampermonkey reports completion. Check unknown outcomes in Chrome Downloads.'))));
    const helpLink = (label, href) => h('a', {href,target:'_blank',rel:'noopener noreferrer'}, label);
    const icon = name => {
      const paths = {
        check:'m8 12 3 3 5-6',
        download:'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
        info:'M12 11v6m0-10v.01',
        folder:'M3 7V5h6l2 2h10v13H3V7Z',
        mail:'M3 5h18v14H3V5Zm0 1 9 7 9-7',
        arrow:'M5 12h14m-5-5 5 5-5 5',
        close:'m6 6 12 12M6 18 18 6'
      };
      const svg = doc.createElementNS('http://www.w3.org/2000/svg','svg');
      for (const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'24',height:'24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
      const path = doc.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d', paths[name]); svg.append(path); return svg;
    };
    const helpTabs = [['setup','Setup'],['guide','How to use'],['fixes','Troubleshooting'],['about','About']];
    const guideStep = (title, description) => h('li', {}, h('strong', {}, title), h('p', {}, description));
    const supportLink = (label, href) => h('a', {class:'support-link',href,target:'_blank',rel:'noopener noreferrer'}, h('span',{},label), icon('arrow'));
    shadow.append(h('section', {id:'help',hidden:true,tabindex:'-1','aria-label':'Attachment Batch help'},
      h('header', {}, h('h1', {}, 'Attachment Batch help'), h('button', {id:'help-close','aria-label':'Close help'}, icon('close'))),
      h('div', {class:'help-tabs',role:'tablist','aria-label':'Help topics'}, helpTabs.map(([id,label],i) => h('button',{id:'help-tab-'+id,role:'tab','aria-controls':'help-page-'+id,'aria-selected':i===0?'true':'false',tabindex:i===0?'0':'-1'},label))),
      h('div', {class:'help-body'},
        h('section', {id:'help-page-setup',role:'tabpanel','aria-labelledby':'help-tab-setup'},
          h('div', {class:'setup-result',id:'setup-result',role:'status','aria-live':'polite','aria-atomic':'true'},
            h('span',{class:'setup-symbol',id:'setup-symbol'},icon('download')),
            h('div', {}, h('h2', {id:'setup-title'}, 'Check your download setup'), h('p', {id:'setup-status'}))),
          h('div', {class:'setup-action'}, h('button', {id:'check-setup',class:'button'}, 'Check download setup'), small('Saves a tiny test file. No email is opened.')),
          h('details', {id:'help-setup-steps'}, h('summary', {}, 'Enable folder downloads'), setupSteps()),
          h('details', {}, h('summary', {}, 'File types and save prompts'), h('p', {}, 'In Tampermonkey → Dashboard → Settings → Downloads, permit .txt for this check, .csv for reports and the attachment extensions you need. A successful .txt check does not verify other file types. Chrome’s “Ask where to save each file” setting controls repeated save prompts.')),
          h('div',{class:'setup-facts'},h('p',{},icon('folder'),h('span',{},'Files go into Gmail attachments in Chrome’s Downloads folder.')),h('p',{},icon('mail'),h('span',{},'Uses the Gmail account already signed in to this tab.')))),
        h('section', {id:'help-page-guide',role:'tabpanel','aria-labelledby':'help-tab-guide',hidden:true},
          h('h2', {}, 'From search to saved files'),
          h('ol', {class:'help-steps'},
            guideStep('Search and capture', 'Check your Gmail search, then choose Download attachments → Capture results. Capture all pages or just the current page.'),
            guideStep('Review your list', 'Choose Review list to filter, sort and page through the table. Untick conversations you do not want.'),
            guideStep('Choose your folders', 'Set a batch name and choose thread subfolders or one batch folder.'),
            guideStep('Download and save the report', 'Choose Download attachments inside the panel. Keep Gmail open while it runs, then Save report.')),
          h('details', {}, h('summary', {}, 'Selecting, pausing and repeating'), h('p', {}, 'Select matching and Exclude matching affect every row matching your filter, across all review pages. Pause finishes the current file, then waits. Stop now cancels an active request where possible. Repeating the same captured batch skips confirmed completed files. Reloading or closing Gmail clears this record. Check unknown outcomes in Chrome Downloads before retrying.')),
          h('p', {class:'help-scope'}, icon('info'), h('span',{},'Each result can be a whole conversation, including replies. Opening unread mail may mark it as read.'))),
        h('section', {id:'help-page-fixes',role:'tabpanel','aria-labelledby':'help-tab-fixes',hidden:true},
          h('details', {}, h('summary', {}, 'Capture has stopped or seems stuck'), h('p', {}, 'A results page normally takes a few seconds. If Gmail does not reach the next page within 20 seconds, capture stops and downloads stay disabled. Choose Stop now if needed, return to the search results and try Capture results again. Refresh Gmail if its page has stopped responding.')),
          h('details', {}, h('summary', {}, 'A file or folder is missing'), h('p', {}, 'Check Chrome Downloads for blocked, cancelled or unfinished files. Open the Setup tab to check download settings. Tampermonkey may need the file extension permitted under Downloads. The destination preview is inside Chrome’s usual download location.')),
          h('details', {}, h('summary', {}, 'A download has an unknown outcome'), h('p', {}, 'Check Chrome Downloads before retrying. An unknown result means completion could not be confirmed. The script never automatically repeats these files. Save the report before closing or refreshing Gmail.')),
          h('details', {}, h('summary', {}, 'Unsupported or no visible attachments'), h('p', {}, 'Drive links and files linked in message text are not ordinary Gmail attachments. Embedded message images are not exported. Gmail layout changes or hidden messages can also require a manual check. A missing visible tile does not prove there were no attachments.')),
          h('p',{class:'small help-support-note'}, 'Still stuck? The About tab has support links and what to include in a report.')),
        h('section', {id:'help-page-about',role:'tabpanel','aria-labelledby':'help-tab-about',hidden:true},
          h('h2', {}, 'Created by Paul Wood FRSA'),
          h('p', {class:'small'}, 'Independent Gmail add-on · v0.4.5'),
          supportLink('paultendo on GitHub', AUTHOR_URL),
          REPOSITORY_URL ? supportLink('Repository and source', REPOSITORY_URL) : null,
          REPOSITORY_URL ? supportLink('Report a problem',REPOSITORY_URL+'/issues') : null,
          supportLink('Buy me a coffee', COFFEE_URL),
          REPOSITORY_URL ? null : small('The source repository and issue tracker will be linked here once published.'),
          h('details', {}, h('summary', {}, 'Reporting a problem'), h('p', {}, 'Include the add-on version, Chrome and Tampermonkey versions, the error message and the step that failed. Use a redacted screenshot or a fictional example rather than sharing private email content.')),
          h('details', {}, h('summary', {}, 'Privacy'), h('p', {}, 'The script reads the signed-in Gmail tab and downloads through Google. It does not upload messages or attachments to a separate service. Reports contain email subjects and search terms; keep them with your downloaded files.')),
          h('details', {}, h('summary', {}, 'Licence and attribution'),
            h('p', {}, 'Copyright © 2026 Paul Wood FRSA. Free software under GNU GPL version 3, with the author-attribution term permitted by section 7(b). No warranty is provided.'),
            h('p', {}, 'Keep “Paul Wood FRSA (paultendo on GitHub)” and the profile link in the source and in Help, About or equivalent legal notices. You may add your own contributor credits.'),
            h('p', {}, helpLink('Read the GNU GPLv3 licence', 'https://www.gnu.org/licenses/gpl-3.0.html'), '. The full licence and attribution notice are included at the end of the installed script.')))),
      h('footer', {}, creatorCredit(), h('button', {id:'help-back',class:'button'}, 'Back to attachments'))));
    const $ = id => shadow.getElementById(id);
    const selectHelpTab = (id, focus = false) => {
      for (const [key] of helpTabs) {
        const active = key === id, tab = $('help-tab-'+key);
        tab.setAttribute('aria-selected',String(active)); tab.setAttribute('tabindex',active?'0':'-1');
        $('help-page-'+key).hidden = !active;
        if (active && focus) tab.focus?.();
      }
      shadow.querySelector('.help-body').scrollTop = 0;
    };
    for (const [id] of helpTabs) {
      const tab = $('help-tab-'+id);
      tab.addEventListener('click',()=>selectHelpTab(id));
      tab.addEventListener('keydown',event=>{
        const index=helpTabs.findIndex(([key])=>key===id);
        const next=event.key==='ArrowRight'?(index+1)%helpTabs.length:event.key==='ArrowLeft'?(index+helpTabs.length-1)%helpTabs.length:event.key==='Home'?0:event.key==='End'?helpTabs.length-1:null;
        if(next!==null){event.preventDefault();selectHelpTab(helpTabs[next][0],true);}
      });
    }
    const readHref = () => demo ? win.__GMAIL_BATCH_HREF__ : win.location.href;
    const setHash = hash => { state.expectedHash = hash; if (demo) win.__GMAIL_BATCH_NAVIGATE__(hash); else win.location.hash = hash; };
    const currentHash = () => new URL(readHref()).hash;
    const rootGuard = () => { if (state.stopped) throw new Error('Stopped by user.'); if (state.snapshot && accountRoot(readHref()) !== state.snapshot.root) throw new Error('Gmail account changed. Batch stopped.'); };
    const routeGuard = () => { rootGuard(); if (currentHash() !== state.expectedHash) throw new Error('Gmail view changed outside the batch. Batch stopped.'); };
    const log = row => { state.log.push({ time: new Date().toISOString(), ...row }); render(); };
    const update = message => { state.message = message; render(); };
    const openPanel = () => { $('help').hidden = true; helpButton.setAttribute('aria-expanded','false'); $('panel').hidden = false; toolbarButton.setAttribute('aria-expanded', 'true'); render(); };
    const toolbarButton = h('button', {id:'gmail-attachment-batch-toolbar',type:'button','aria-expanded':'false',title:'Review and download attachments from this Gmail search'}, 'Download attachments');
    const helpButton = h('button',{id:'gmail-attachment-batch-help',type:'button','aria-expanded':'false',title:'Attachment Batch help and support'},'Help');
    const toolbarGroup = h('div',{id:'gmail-attachment-batch-actions'});
    Object.assign(toolbarGroup.style,{display:'inline-flex',verticalAlign:'top',height:'32px',margin:'0 8px'});
    const groupShadow = toolbarGroup.attachShadow({mode:'open'}), groupStyle = h('style');
    groupStyle.textContent = ':host{all:initial;display:inline-flex;vertical-align:top;height:32px;margin:0 8px;font:12px/18px "Google Sans",Roboto,Arial,sans-serif;color:#444746}*{box-sizing:border-box}.group{display:inline-flex;align-items:center;gap:4px;height:32px;padding:2px 3px 2px 10px;border:1px solid #dadce0;border-radius:8px;background:#f8fafd;white-space:nowrap}.brand{font-size:12px;line-height:16px;font-weight:500;margin-right:4px;padding-right:10px;border-right:1px solid #dadce0}button{font:500 12px/18px "Google Sans",Roboto,Arial,sans-serif;height:26px;padding:4px 10px;cursor:pointer;border:0;border-radius:14px;white-space:nowrap;color:#001d35;background:#c2e7ff}button:hover{background:#b3dcfa}button:focus-visible{outline:2px solid #0b57d0;outline-offset:2px}#gmail-attachment-batch-help{background:transparent;color:#0b57d0;padding-inline:10px}#gmail-attachment-batch-help:hover{background:#e8f0fe}@media(max-width:800px){.brand{font-size:11px;padding-right:8px}.group{gap:2px;padding-left:8px}button{padding-inline:8px}}';
    groupShadow.append(groupStyle,h('div',{class:'group',role:'group','aria-label':'Attachment Batch add-on'},h('span',{class:'brand'},'Attachment Batch'),toolbarButton,helpButton));
    const openHelp = () => { $('panel').hidden = true; toolbarButton.setAttribute('aria-expanded','false'); $('help').hidden = false; helpButton.setAttribute('aria-expanded','true'); $('help').focus?.(); };
    toolbarButton.addEventListener('click', openPanel);
    helpButton.addEventListener('click', openHelp);
    async function checkSetup() {
      if (state.busy || state.reportSaving || state.checkingSetup || downloadMode() !== 'browser') return;
      state.checkingSetup = true; state.setupTone = 'checking';
      state.setupMessage = demo ? 'Simulating a download check…' : 'Saving a small test file…'; render();
      try {
        if (typeof GM_download !== 'function') throw new Error('Tampermonkey downloads are unavailable. Reinstall the script in Tampermonkey and refresh Gmail.');
        await downloadOne(GM_download, {url:new Blob(['Gmail Attachment Batch setup check. No email data is included.\n'], {type:'text/plain;charset=utf-8'})}, 'Gmail attachments/setup-check.txt', () => {}, 15000);
        state.setupTone = 'success';
        state.setupMessage = demo
          ? 'Demo check passed. No real file was saved. Run this check in Gmail after installing.'
          : 'Saved setup-check.txt. Confirm it is inside Gmail attachments in Chrome Downloads, then try a small batch.';
      } catch (error) {
        state.setupTone = 'error';
        const fixes = {
          not_enabled: 'Downloads are switched off. Enable folder downloads below, save the setting and refresh Gmail.',
          not_permitted: 'Chrome download permission is missing. In Tampermonkey → Dashboard → Settings → Downloads, select Browser API, save and allow the requested download permission. Then refresh Gmail.',
          not_whitelisted: 'Tampermonkey has blocked .txt files. In Dashboard → Settings → Downloads, add .txt to Whitelisted File Extensions, save and refresh Gmail. Permit the attachment types you need and .csv for reports too.',
          not_supported: 'This Tampermonkey or browser version does not support these downloads. Update Chrome and Tampermonkey, then refresh Gmail.',
          not_succeeded: 'The test file was not confirmed saved. Check Chrome Downloads for a blocked or cancelled file before trying again.'
        };
        state.setupMessage = fixes[error.code] || (error.unknown ? 'The test outcome is unknown. Check Chrome Downloads before running the check again.' : error.message);
      } finally { state.checkingSetup = false; render(); }
    }
    $('check-setup').addEventListener('click', checkSetup);
    $('help-close').addEventListener('click', () => { $('help').hidden = true; helpButton.setAttribute('aria-expanded','false'); helpButton.focus?.(); });
    $('help-back').addEventListener('click', openPanel);
    $('help').addEventListener('keydown', event => { if(event.key === 'Escape') { $('help').hidden = true; helpButton.setAttribute('aria-expanded','false'); helpButton.focus?.(); } });
    let toolbarShift = 0;
    function alignToolbarGroup() {
      const toolbar = toolbarGroup.parentElement;
      const refresh = toolbar && control(toolbar, /^Refresh$/i);
      if (!refresh?.getBoundingClientRect || !toolbarGroup.getBoundingClientRect) return;
      const native = refresh.getBoundingClientRect(), own = toolbarGroup.getBoundingClientRect();
      if (!native.height || !own.height) return;
      // Follow the native control's centre. Include the existing translation
      // because getBoundingClientRect already reflects it; repeated layout
      // notifications must not accumulate an offset.
      const next = Math.round((toolbarShift + native.top + native.height / 2 - own.top - own.height / 2) * 100) / 100;
      if (Math.abs(next - toolbarShift) < 0.1) return;
      toolbarShift = next;
      toolbarGroup.style.transform = `translateY(${next}px)`;
    }
    const toolbarResizeObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(alignToolbarGroup) : null;
    toolbarResizeObserver?.observe(toolbarGroup);
    function ensureToolbarButton() {
      let searching = false;
      try { searchState(readHref()); searching = true; } catch {}
      if (!searching) { toolbarGroup.remove(); return; }
      // Keep this in the message-actions row, immediately after More. The
      // search-refinement toolbar has its own grid and must not be extended.
      const toolbar = [...doc.querySelectorAll('[gh="tm"] .G-tF')].find(el =>
        shown(el) && !el.closest('.a3s') && control(el, /^Refresh$/i));
      if (toolbar && toolbarGroup.parentElement !== toolbar) toolbar.append(toolbarGroup);
      alignToolbarGroup();
    }
    let toolbarUpdateQueued = false;
    const toolbarObserver = new win.MutationObserver(() => {
      if (toolbarUpdateQueued) return;
      toolbarUpdateQueued = true;
      queueMicrotask(() => { toolbarUpdateQueued = false; ensureToolbarButton(); });
    });
    toolbarObserver.observe(doc.body || doc.documentElement, {childList:true,subtree:true});
    win.addEventListener('hashchange', ensureToolbarButton);
    win.addEventListener('resize', alignToolbarGroup);
    ensureToolbarButton();

    function render() {
      $('capture').disabled = state.busy || state.checkingSetup;
      $('pages').disabled = state.busy;
      const needsSetup = downloadMode() !== 'browser';
      $('setup-status').textContent = state.setupMessage || (needsSetup
        ? 'Follow the steps below, save the setting, then refresh Gmail.'
        : 'Folder downloads are enabled. Save a small test file to check permission.');
      const tone = state.setupTone || (needsSetup ? 'action' : 'ready');
      $('setup-result').setAttribute('data-tone',tone);
      $('setup-title').textContent = ({success:'Download check passed',error:'Download setup needs attention',checking:'Checking your download…',action:'Enable folder downloads',ready:'Check your download setup'})[tone];
      $('setup-symbol').replaceChildren(icon(tone==='success'?'check':tone==='error'?'info':'download'));
      $('help-setup-steps').open = needsSetup;
      $('check-setup').disabled = needsSetup || state.busy || state.checkingSetup || state.reportSaving;
      $('check-setup').textContent = state.checkingSetup ? 'Checking…' : state.setupTone === 'success' ? 'Check again' : 'Check download setup';
      $('download-setup').hidden = !needsSetup;
      if (needsSetup) $('download-setup').open = true;
      $('download').disabled = needsSetup || state.busy || state.checkingSetup || !state.snapshot || !state.snapshot.refs.some(r => r.selected);
      $('pause').disabled = !state.busy || state.phase === 'capturing';
      $('pause').textContent = state.paused ? 'Resume' : 'Pause';
      $('stop').disabled = !state.busy;
      $('report').disabled = state.busy || state.reportSaving || state.checkingSetup || !state.log.length;
      $('report').textContent = state.reportSaving ? 'Saving report…' : 'Save report';
      $('preview').hidden = !state.snapshot?.refs;
      $('scope').hidden = !state.snapshot;
      if (state.snapshot) {
        $('scope').textContent = state.snapshot.query + '\n' + (state.snapshot.complete ? `${state.snapshot.pages} page(s) captured` : state.phase === 'capturing' ? `Capturing: ${state.snapshot.refs.length} conversations from ${state.snapshot.pages} page(s). Downloads unlock when capture finishes.` : 'Capture incomplete - downloading disabled');
        const selected = state.snapshot.refs.filter(r => r.selected).length;
        $('count').textContent = selected;
        $('selection').textContent = `of ${state.snapshot.refs.length} captured result conversations selected`;
      }
      if (state.snapshot && !state.snapshot.complete) $('download').disabled = true;
      $('status').textContent = state.message;
      $('status').classList.toggle('error', ['failed', 'stopped'].includes(state.phase));
      $('progress').hidden = !state.busy || state.phase === 'capturing';
      $('progress').max = Math.max(1, state.snapshot?.refs.filter(r => r.selected).length || 1);
      $('progress').value = state.processed;
      shadow.querySelectorAll('#rows input').forEach(input => { input.disabled = state.busy; });
      $('select-matching').disabled = state.busy; $('exclude-matching').disabled = state.busy;
      $('folder-name').disabled = state.busy; $('folder-layout').disabled = state.busy;
      const folder = safeFolder($('folder-name').value || 'Batch folder');
      $('destination-preview').textContent = `Inside Chrome’s Downloads folder: Gmail attachments/${folder}/${$('folder-layout').value === 'flat' ? '' : '[thread subject + ID]/'}[attachment].`;
    }

    function filteredRefs() {
      const query = state.reviewQuery.trim().toLowerCase();
      const refs = (state.snapshot?.refs || []).filter(ref =>
        (!query || [ref.subject, ref.sender, ref.date].join(' ').toLowerCase().includes(query)) &&
        (state.reviewSelection === 'all' || (state.reviewSelection === 'selected' ? ref.selected : !ref.selected)));
      if (state.reviewSort !== 'captured') refs.sort((a,b) => (a[state.reviewSort] || '').localeCompare(b[state.reviewSort] || ''));
      return refs;
    }
    function showRows() {
      const refs = filteredRefs(), pageSize = state.expanded ? 25 : 5;
      const pages = Math.max(1, Math.ceil(refs.length / pageSize));
      state.reviewPage = Math.min(Math.max(1, state.reviewPage), pages);
      const start = (state.reviewPage - 1) * pageSize;
      const tbody = h('tbody');
      for (const ref of refs.slice(start, start + pageSize)) {
        const box = h('input', {type:'checkbox','aria-label':`Include ${ref.subject}`}); box.checked = ref.selected; box.disabled = state.busy;
        box.addEventListener('change', () => { ref.selected = box.checked; showRows(); render(); });
        tbody.append(h('tr', {class:ref.selected ? 'selected' : ''}, h('td', {}, box), h('td', {}, ref.subject), h('td', {class:'detail'}, ref.sender || '—'), h('td', {class:'detail date-col'}, ref.date || '—')));
      }
      if (!refs.length) tbody.append(h('tr', {}, h('td', {colspan:'4',class:'empty'}, state.phase === 'capturing' ? 'Waiting for Gmail results…' : 'No conversations match this filter.')));
      $('rows').replaceChildren(h('table', {class:'review-table','aria-label':'Captured conversations'}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Subject'), h('th', {class:'detail'}, 'Sender'), h('th', {class:'detail date-col'}, 'Date'))), tbody));
      $('review-range').textContent = refs.length ? `${start + 1}–${Math.min(start + pageSize, refs.length)} of ${refs.length}${state.reviewQuery || state.reviewSelection !== 'all' ? ' matching' : ''} · page ${state.reviewPage} of ${pages}` : '0 matching conversations';
      $('review-prev').disabled = state.reviewPage <= 1; $('review-next').disabled = state.reviewPage >= pages;
    }

    async function stableResults(search, oldSignature = null, expectedPage = null) {
      let last = '', stableAt = 0;
      return waitFor(() => {
        const current = searchState(readHref());
        if (current.query !== search.query || current.root !== search.root) throw new Error('The Gmail search/account changed during capture.');
        if (expectedPage !== null && current.page !== expectedPage) return false;
        let refs;
        try { refs = resultRows(doc); } catch (e) { if (!mainPane(doc)) return false; throw e; }
        const signature = refs.map(r => r.kind + ':' + r.id).join('|');
        if (!signature || signature === oldSignature) return false;
        if (signature !== last) { last = signature; stableAt = Date.now(); return false; }
        return Date.now() - stableAt >= 800 ? refs : false;
      }, rootGuard);
    }

    async function capture() {
      if (state.busy || state.checkingSetup || state.reportSaving) return;
      openPanel(); state.stopped = false; state.paused = false; state.busy = true; state.phase = 'capturing';
      state.snapshot = null; state.log = []; state.done.clear(); state.unknown.clear(); state.planned.clear(); state.visited.clear(); state.processed = 0; state.reviewPage = 1; state.reviewQuery = ''; state.reviewSelection = 'all'; $('review-filter').value = ''; $('review-selection').querySelector('option[value="all"]').selected = true;
      update('Reading Gmail search results…');
      const refs = new Map(); let pages = 0;
      try {
        const search = searchState(readHref());
        state.snapshot = { ...search, refs: [], pages: 0, complete: false };
        $('folder-name').value = batchFolderName(search.query);
        let firstPageOldSignature = null;
        if ($('pages').value === 'all' && search.page !== 1) {
          firstPageOldSignature = resultRows(doc).map(r => r.kind + ':' + r.id).join('|');
          setHash(search.baseHash);
        }
        let currentPage = $('pages').value === 'all' ? 1 : search.page;
        let page = await stableResults(search, firstPageOldSignature, currentPage), previousSignature = null;
        const seenPages = new Set();
        while (true) {
          rootGuard();
          const signature = page.map(r => r.kind + ':' + r.id).join('|');
          if (seenPages.has(signature)) throw new Error('Gmail repeated a result page. Capture stopped before downloading.');
          seenPages.add(signature); pages++;
          page.forEach(ref => refs.set(ref.kind + ':' + ref.id, ref));
          state.snapshot.refs = [...refs.values()]; state.snapshot.pages = pages; showRows();
          update(`Captured ${refs.size} conversations across ${pages} page(s)…`);
          if ($('pages').value === 'page') break;
          const older = control(doc, /^Older$/i);
          if (!older) throw new Error('Gmail’s Older-results control was not recognised. Choose This results page only, or use English Gmail.');
          if (!enabled(older)) break;
          previousSignature = signature;
          currentPage++;
          update(`Captured ${refs.size} conversations. Loading results page ${currentPage}…`);
          setHash(search.baseHash + '/p' + currentPage);
          page = await stableResults(search, previousSignature, currentPage);
        }
        state.snapshot.refs = [...refs.values()]; state.snapshot.pages = pages; state.snapshot.complete = true;
        state.phase = 'ready'; showRows();
        update(`Ready. Review ${refs.size} result conversations before starting. Attachment counts are discovered when each conversation opens.`);
      } catch (error) {
        if (state.snapshot) { state.snapshot.refs = [...refs.values()]; state.snapshot.pages = pages; showRows(); }
        state.phase = state.stopped ? 'stopped' : 'failed'; update(error.message);
      } finally { state.busy = false; render(); }
    }

    async function gate() {
      while (state.paused) { rootGuard(); await sleep(150); }
      rootGuard();
    }

    async function openResult(ref) {
      setHash(ref.hash);
      // Gmail rewrites legacy hex routes to opaque permanent conversation URLs.
      // Adopt that route only after the native header confirms the captured ID.
      let matchingHash = '', matchedAt = 0;
      await waitFor(() => {
        const hash = currentHash();
        if (hash !== ref.hash && !/^#all\/[A-Za-z0-9_-]+$/.test(hash)) throw new Error('Gmail view changed outside the batch. Batch stopped.');
        if (!isExpectedThread(doc, ref)) { matchedAt = 0; return false; }
        if (hash !== matchingHash || !matchedAt) { matchingHash = hash; matchedAt = Date.now(); return false; }
        if (Date.now() - matchedAt < 800) return false;
        state.expectedHash = hash;
        return true;
      }, rootGuard);
      // Expand only Gmail's named conversation control, never arbitrary buttons.
      const expand = control(mainPane(doc), /^Expand all(?:\b|$)/i);
      if (expand && enabled(expand)) {
        expand.click();
        await waitFor(() => !control(mainPane(doc), /^Expand all(?:\b|$)/i), routeGuard);
      }
      let previous = '', stableAt = Date.now();
      await waitFor(() => {
        const main = mainPane(doc);
        const signature = [...main.querySelectorAll('.aQH')].map(el => el.innerHTML).join('|');
        if (signature !== previous) { previous = signature; stableAt = Date.now(); return false; }
        return Date.now() - stableAt > 1400;
      }, routeGuard);
      return collectAttachments(doc, ref, state.snapshot.root);
    }

    async function run() {
      if (state.busy || state.checkingSetup || state.reportSaving || !state.snapshot?.complete) return;
      if (typeof GM_download !== 'function') { update('Tampermonkey downloads are unavailable. Install the script in Tampermonkey first.'); return; }
      if (downloadMode() !== 'browser') { $('download-setup').open = true; update('Folder downloads need a one-time setup. Follow “Enable folder downloads”, then refresh Gmail.'); return; }
      if (typeof GM_info !== 'undefined' && GM_info.downloadMode === 'disabled') { update('Enable downloads in Tampermonkey settings, then start again.'); return; }
      if (accountRoot(readHref()) !== state.snapshot.root) { update('Return to the Gmail account whose results you captured.'); return; }
      try {
        if (searchState(readHref()).query !== state.snapshot.query) throw new Error('changed');
      } catch { update('Return to the captured search results, or capture your new search before downloading.'); return; }
      const selected = state.snapshot.refs.filter(r => r.selected);
      if (!selected.length) return;
      state.busy = true; state.stopped = false; state.paused = false; state.processed = 0; state.phase = 'running';
      const destination = {folder: safeFolder($('folder-name').value || batchFolderName(state.snapshot.query)), layout: $('folder-layout').value || 'threads'};
      state.snapshot.destination = destination;
      let gaps = false;
      try {
        for (const ref of selected) {
          await gate(); update(`Opening ${state.processed + 1}/${selected.length}: ${ref.subject}`);
          const { files, issues } = await openResult(ref);
          state.visited.add(ref.id);
          files.forEach(file => state.planned.set(file.key, { subject: ref.subject, result_id: ref.id, message_id: file.messageId, attachment_key: file.key, filename: file.filename, status: 'not_attempted', detail: 'Attachment was discovered but has not been attempted in this tab.' }));
          for (const issue of issues) { gaps = true; log({ subject: ref.subject, result_id: ref.id, filename: issue.filename, status: 'unsupported', detail: issue.message }); }
          if (!files.length && !issues.length) log({ subject: ref.subject, result_id: ref.id, status: 'no_visible_attachments', detail: 'No supported attachment tiles were visible after expanding the conversation.' });
          for (const [fileIndex, file] of files.entries()) {
            await gate(); routeGuard();
            if (state.done.has(file.key)) continue;
            if (state.unknown.has(file.key)) { gaps = true; continue; }
            const name = attachmentPath(destination.folder, destination.layout, ref, file, fileIndex);
            update(`Saving ${file.filename}…\n${state.done.size} file(s) saved so far.`);
            try {
              await downloadOne(GM_download, file, name, handle => { state.handle = handle; });
              state.done.add(file.key);
              log({ subject: ref.subject, result_id: ref.id, message_id: file.messageId, attachment_key: file.key, filename: file.filename, requested_name: name, status: 'saved', detail: 'Tampermonkey completion callback received; file contents not independently checked.' });
            } catch (error) {
              gaps = true;
              const unknown = error.unknown || state.stopped;
              if (unknown) state.unknown.add(file.key);
              log({ subject: ref.subject, result_id: ref.id, message_id: file.messageId, attachment_key: file.key, filename: file.filename, requested_name: name, status: unknown ? 'unknown' : 'failed', detail: error.message });
              throw error;
            }
          }
          state.processed++; render();
        }
        state.phase = gaps ? 'failed' : 'finished';
        update(`${gaps ? 'Finished with gaps' : 'Finished'}: ${state.done.size} file(s) saved; ${state.processed}/${selected.length} conversations processed. Save the report${gaps ? ' and check its unresolved entries' : ''}.`);
      } catch (error) { state.phase = state.stopped ? 'stopped' : 'failed'; update(`${error.message}\n${state.done.size} file(s) saved. Completed files are skipped if you run this captured batch again. Unknown outcomes are not retried automatically.`); }
      finally {
        state.busy = false; state.paused = false; state.handle = null;
        if (currentHash() === state.expectedHash && accountRoot(readHref()) === state.snapshot.root) setHash(state.snapshot.originalHash);
        render();
      }
    }

    $('folder-name').addEventListener('input', render);
    $('folder-layout').addEventListener('change', render);
    $('expand').addEventListener('click', () => {
      state.expanded = !state.expanded; state.reviewPage = 1;
      $('panel').classList.toggle('expanded', state.expanded); $('expand').textContent = state.expanded ? 'Compact view' : 'Review list'; showRows();
    });
    $('review-filter').addEventListener('input', () => { state.reviewQuery = $('review-filter').value; state.reviewPage = 1; showRows(); });
    $('review-selection').addEventListener('change', () => { state.reviewSelection = $('review-selection').value; state.reviewPage = 1; showRows(); });
    $('review-sort').addEventListener('change', () => { state.reviewSort = $('review-sort').value; state.reviewPage = 1; showRows(); });
    $('review-prev').addEventListener('click', () => { state.reviewPage--; showRows(); });
    $('review-next').addEventListener('click', () => { state.reviewPage++; showRows(); });
    for (const [id, selected] of [['select-matching',true],['exclude-matching',false]]) $(id).addEventListener('click', () => {
      if (state.busy) return; filteredRefs().forEach(ref => { ref.selected = selected; }); showRows(); render();
    });
    $('close').addEventListener('click', () => { $('panel').hidden = true; toolbarButton.setAttribute('aria-expanded', 'false'); });
    $('capture').addEventListener('click', capture);
    $('download').addEventListener('click', run);
    $('pause').addEventListener('click', () => { state.paused = !state.paused; update(state.paused ? 'Pausing after the current file. Resume when ready.' : 'Resuming…'); });
    $('stop').addEventListener('click', () => { state.stopped = true; state.paused = false; state.handle?.abort?.(); update('Stopping. An in-flight download may need checking in Chrome Downloads.'); });
    $('report').addEventListener('click', async () => {
      if (state.busy || state.checkingSetup || state.reportSaving || !state.log.length) return;
      state.reportSaving = true; render();
      try {
        const folder = state.snapshot.destination?.folder || $('folder-name').value || batchFolderName(state.snapshot.query);
        const name = `Gmail attachments/${safeFolder(folder)}/batch-report.csv`;
        await downloadOne(GM_download, {url:new Blob([reportCsv(state)],{type:'text/csv;charset=utf-8'})}, name, () => {});
        update(`Report saved in Gmail attachments/${safeFolder(folder)}/batch-report.csv. ${state.done.size} attachment(s) saved.`);
      } catch (error) { update(`Report could not be confirmed saved: ${error.message}. Check Chrome Downloads before retrying.`); }
      finally { state.reportSaving = false; render(); }
    });
    if (typeof GM_registerMenuCommand === 'function') { GM_registerMenuCommand('Open Attachment batch', openPanel); GM_registerMenuCommand('Attachment Batch help', openHelp); }
    win.addEventListener('beforeunload', event => { if (state.busy || state.checkingSetup) { event.preventDefault(); event.returnValue = ''; } });
    render();
    return { state, capture, run, checkSetup, shadow, toolbarButton, toolbarGroup, helpButton, filteredRefs, showRows, dispose: () => { toolbarObserver.disconnect(); toolbarResizeObserver?.disconnect(); win.removeEventListener('hashchange',ensureToolbarButton); win.removeEventListener('resize',alignToolbarGroup); } };
  }

  return { accountRoot, searchState, resultRows, rowReference, control, enabled, safeFilename, safeFolder, batchFolderName, attachmentPath, attachmentUrl,
    collectAttachments, isExpectedThread, reportCsv, downloadOne, mount };
});

/* BEGIN ATTACHMENT BATCH LICENCE
GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright © 2007 Free Software Foundation, Inc. <https://fsf.org/>

Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.

Preamble

The GNU General Public License is a free, copyleft license for software and other kinds of works.

The licenses for most software and other practical works are designed to take away your freedom to share and change the works. By contrast, the GNU General Public License is intended to guarantee your freedom to share and change all versions of a program--to make sure it remains free software for all its users. We, the Free Software Foundation, use the GNU General Public License for most of our software; it applies also to any other work released this way by its authors. You can apply it to your programs, too.

When we speak of free software, we are referring to freedom, not price. Our General Public Licenses are designed to make sure that you have the freedom to distribute copies of free software (and charge for them if you wish), that you receive source code or can get it if you want it, that you can change the software or use pieces of it in new free programs, and that you know you can do these things.

To protect your rights, we need to prevent others from denying you these rights or asking you to surrender the rights. Therefore, you have certain responsibilities if you distribute copies of the software, or if you modify it: responsibilities to respect the freedom of others.

For example, if you distribute copies of such a program, whether gratis or for a fee, you must pass on to the recipients the same freedoms that you received. You must make sure that they, too, receive or can get the source code. And you must show them these terms so they know their rights.

Developers that use the GNU GPL protect your rights with two steps: (1) assert copyright on the software, and (2) offer you this License giving you legal permission to copy, distribute and/or modify it.

For the developers' and authors' protection, the GPL clearly explains that there is no warranty for this free software. For both users' and authors' sake, the GPL requires that modified versions be marked as changed, so that their problems will not be attributed erroneously to authors of previous versions.

Some devices are designed to deny users access to install or run modified versions of the software inside them, although the manufacturer can do so. This is fundamentally incompatible with the aim of protecting users' freedom to change the software. The systematic pattern of such abuse occurs in the area of products for individuals to use, which is precisely where it is most unacceptable. Therefore, we have designed this version of the GPL to prohibit the practice for those products. If such problems arise substantially in other domains, we stand ready to extend this provision to those domains in future versions of the GPL, as needed to protect the freedom of users.

Finally, every program is threatened constantly by software patents. States should not allow patents to restrict development and use of software on general-purpose computers, but in those that do, we wish to avoid the special danger that patents applied to a free program could make it effectively proprietary. To prevent this, the GPL assures that patents cannot be used to render the program non-free.

The precise terms and conditions for copying, distribution and modification follow.

TERMS AND CONDITIONS

0. Definitions.

“This License” refers to version 3 of the GNU General Public License.

“Copyright” also means copyright-like laws that apply to other kinds of works, such as semiconductor masks.

“The Program” refers to any copyrightable work licensed under this License. Each licensee is addressed as “you”. “Licensees” and “recipients” may be individuals or organizations.

To “modify” a work means to copy from or adapt all or part of the work in a fashion requiring copyright permission, other than the making of an exact copy. The resulting work is called a “modified version” of the earlier work or a work “based on” the earlier work.

A “covered work” means either the unmodified Program or a work based on the Program.

To “propagate” a work means to do anything with it that, without permission, would make you directly or secondarily liable for infringement under applicable copyright law, except executing it on a computer or modifying a private copy. Propagation includes copying, distribution (with or without modification), making available to the public, and in some countries other activities as well.

To “convey” a work means any kind of propagation that enables other parties to make or receive copies. Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying.

An interactive user interface displays “Appropriate Legal Notices” to the extent that it includes a convenient and prominently visible feature that (1) displays an appropriate copyright notice, and (2) tells the user that there is no warranty for the work (except to the extent that warranties are provided), that licensees may convey the work under this License, and how to view a copy of this License. If the interface presents a list of user commands or options, such as a menu, a prominent item in the list meets this criterion.

1. Source Code.
The “source code” for a work means the preferred form of the work for making modifications to it. “Object code” means any non-source form of a work.

A “Standard Interface” means an interface that either is an official standard defined by a recognized standards body, or, in the case of interfaces specified for a particular programming language, one that is widely used among developers working in that language.

The “System Libraries” of an executable work include anything, other than the work as a whole, that (a) is included in the normal form of packaging a Major Component, but which is not part of that Major Component, and (b) serves only to enable use of the work with that Major Component, or to implement a Standard Interface for which an implementation is available to the public in source code form. A “Major Component”, in this context, means a major essential component (kernel, window system, and so on) of the specific operating system (if any) on which the executable work runs, or a compiler used to produce the work, or an object code interpreter used to run it.

The “Corresponding Source” for a work in object code form means all the source code needed to generate, install, and (for an executable work) run the object code and to modify the work, including scripts to control those activities. However, it does not include the work's System Libraries, or general-purpose tools or generally available free programs which are used unmodified in performing those activities but which are not part of the work. For example, Corresponding Source includes interface definition files associated with source files for the work, and the source code for shared libraries and dynamically linked subprograms that the work is specifically designed to require, such as by intimate data communication or control flow between those subprograms and other parts of the work.

The Corresponding Source need not include anything that users can regenerate automatically from other parts of the Corresponding Source.

The Corresponding Source for a work in source code form is that same work.

2. Basic Permissions.
All rights granted under this License are granted for the term of copyright on the Program, and are irrevocable provided the stated conditions are met. This License explicitly affirms your unlimited permission to run the unmodified Program. The output from running a covered work is covered by this License only if the output, given its content, constitutes a covered work. This License acknowledges your rights of fair use or other equivalent, as provided by copyright law.

You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force. You may convey covered works to others for the sole purpose of having them make modifications exclusively for you, or provide you with facilities for running those works, provided that you comply with the terms of this License in conveying all material for which you do not control copyright. Those thus making or running the covered works for you must do so exclusively on your behalf, under your direction and control, on terms that prohibit them from making any copies of your copyrighted material outside their relationship with you.

Conveying under any other circumstances is permitted solely under the conditions stated below. Sublicensing is not allowed; section 10 makes it unnecessary.

3. Protecting Users' Legal Rights From Anti-Circumvention Law.
No covered work shall be deemed part of an effective technological measure under any applicable law fulfilling obligations under article 11 of the WIPO copyright treaty adopted on 20 December 1996, or similar laws prohibiting or restricting circumvention of such measures.

When you convey a covered work, you waive any legal power to forbid circumvention of technological measures to the extent such circumvention is effected by exercising rights under this License with respect to the covered work, and you disclaim any intention to limit operation or modification of the work as a means of enforcing, against the work's users, your or third parties' legal rights to forbid circumvention of technological measures.

4. Conveying Verbatim Copies.
You may convey verbatim copies of the Program's source code as you receive it, in any medium, provided that you conspicuously and appropriately publish on each copy an appropriate copyright notice; keep intact all notices stating that this License and any non-permissive terms added in accord with section 7 apply to the code; keep intact all notices of the absence of any warranty; and give all recipients a copy of this License along with the Program.

You may charge any price or no price for each copy that you convey, and you may offer support or warranty protection for a fee.

5. Conveying Modified Source Versions.
You may convey a work based on the Program, or the modifications to produce it from the Program, in the form of source code under the terms of section 4, provided that you also meet all of these conditions:

     a) The work must carry prominent notices stating that you modified it, and giving a relevant date.

     b) The work must carry prominent notices stating that it is released under this License and any conditions added under section 7. This requirement modifies the requirement in section 4 to “keep intact all notices”.

     c) You must license the entire work, as a whole, under this License to anyone who comes into possession of a copy. This License will therefore apply, along with any applicable section 7 additional terms, to the whole of the work, and all its parts, regardless of how they are packaged. This License gives no permission to license the work in any other way, but it does not invalidate such permission if you have separately received it.

     d) If the work has interactive user interfaces, each must display Appropriate Legal Notices; however, if the Program has interactive interfaces that do not display Appropriate Legal Notices, your work need not make them do so.

A compilation of a covered work with other separate and independent works, which are not by their nature extensions of the covered work, and which are not combined with it such as to form a larger program, in or on a volume of a storage or distribution medium, is called an “aggregate” if the compilation and its resulting copyright are not used to limit the access or legal rights of the compilation's users beyond what the individual works permit. Inclusion of a covered work in an aggregate does not cause this License to apply to the other parts of the aggregate.

6. Conveying Non-Source Forms.
You may convey a covered work in object code form under the terms of sections 4 and 5, provided that you also convey the machine-readable Corresponding Source under the terms of this License, in one of these ways:

     a) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by the Corresponding Source fixed on a durable physical medium customarily used for software interchange.

     b) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by a written offer, valid for at least three years and valid for as long as you offer spare parts or customer support for that product model, to give anyone who possesses the object code either (1) a copy of the Corresponding Source for all the software in the product that is covered by this License, on a durable physical medium customarily used for software interchange, for a price no more than your reasonable cost of physically performing this conveying of source, or (2) access to copy the Corresponding Source from a network server at no charge.

     c) Convey individual copies of the object code with a copy of the written offer to provide the Corresponding Source. This alternative is allowed only occasionally and noncommercially, and only if you received the object code with such an offer, in accord with subsection 6b.

     d) Convey the object code by offering access from a designated place (gratis or for a charge), and offer equivalent access to the Corresponding Source in the same way through the same place at no further charge. You need not require recipients to copy the Corresponding Source along with the object code. If the place to copy the object code is a network server, the Corresponding Source may be on a different server (operated by you or a third party) that supports equivalent copying facilities, provided you maintain clear directions next to the object code saying where to find the Corresponding Source. Regardless of what server hosts the Corresponding Source, you remain obligated to ensure that it is available for as long as needed to satisfy these requirements.

     e) Convey the object code using peer-to-peer transmission, provided you inform other peers where the object code and Corresponding Source of the work are being offered to the general public at no charge under subsection 6d.

A separable portion of the object code, whose source code is excluded from the Corresponding Source as a System Library, need not be included in conveying the object code work.

A “User Product” is either (1) a “consumer product”, which means any tangible personal property which is normally used for personal, family, or household purposes, or (2) anything designed or sold for incorporation into a dwelling. In determining whether a product is a consumer product, doubtful cases shall be resolved in favor of coverage. For a particular product received by a particular user, “normally used” refers to a typical or common use of that class of product, regardless of the status of the particular user or of the way in which the particular user actually uses, or expects or is expected to use, the product. A product is a consumer product regardless of whether the product has substantial commercial, industrial or non-consumer uses, unless such uses represent the only significant mode of use of the product.

“Installation Information” for a User Product means any methods, procedures, authorization keys, or other information required to install and execute modified versions of a covered work in that User Product from a modified version of its Corresponding Source. The information must suffice to ensure that the continued functioning of the modified object code is in no case prevented or interfered with solely because modification has been made.

If you convey an object code work under this section in, or with, or specifically for use in, a User Product, and the conveying occurs as part of a transaction in which the right of possession and use of the User Product is transferred to the recipient in perpetuity or for a fixed term (regardless of how the transaction is characterized), the Corresponding Source conveyed under this section must be accompanied by the Installation Information. But this requirement does not apply if neither you nor any third party retains the ability to install modified object code on the User Product (for example, the work has been installed in ROM).

The requirement to provide Installation Information does not include a requirement to continue to provide support service, warranty, or updates for a work that has been modified or installed by the recipient, or for the User Product in which it has been modified or installed. Access to a network may be denied when the modification itself materially and adversely affects the operation of the network or violates the rules and protocols for communication across the network.

Corresponding Source conveyed, and Installation Information provided, in accord with this section must be in a format that is publicly documented (and with an implementation available to the public in source code form), and must require no special password or key for unpacking, reading or copying.

7. Additional Terms.
“Additional permissions” are terms that supplement the terms of this License by making exceptions from one or more of its conditions. Additional permissions that are applicable to the entire Program shall be treated as though they were included in this License, to the extent that they are valid under applicable law. If additional permissions apply only to part of the Program, that part may be used separately under those permissions, but the entire Program remains governed by this License without regard to the additional permissions.

When you convey a copy of a covered work, you may at your option remove any additional permissions from that copy, or from any part of it. (Additional permissions may be written to require their own removal in certain cases when you modify the work.) You may place additional permissions on material, added by you to a covered work, for which you have or can give appropriate copyright permission.

Notwithstanding any other provision of this License, for material you add to a covered work, you may (if authorized by the copyright holders of that material) supplement the terms of this License with terms:

     a) Disclaiming warranty or limiting liability differently from the terms of sections 15 and 16 of this License; or

     b) Requiring preservation of specified reasonable legal notices or author attributions in that material or in the Appropriate Legal Notices displayed by works containing it; or

     c) Prohibiting misrepresentation of the origin of that material, or requiring that modified versions of such material be marked in reasonable ways as different from the original version; or

     d) Limiting the use for publicity purposes of names of licensors or authors of the material; or

     e) Declining to grant rights under trademark law for use of some trade names, trademarks, or service marks; or

     f) Requiring indemnification of licensors and authors of that material by anyone who conveys the material (or modified versions of it) with contractual assumptions of liability to the recipient, for any liability that these contractual assumptions directly impose on those licensors and authors.

All other non-permissive additional terms are considered “further restrictions” within the meaning of section 10. If the Program as you received it, or any part of it, contains a notice stating that it is governed by this License along with a term that is a further restriction, you may remove that term. If a license document contains a further restriction but permits relicensing or conveying under this License, you may add to a covered work material governed by the terms of that license document, provided that the further restriction does not survive such relicensing or conveying.

If you add terms to a covered work in accord with this section, you must place, in the relevant source files, a statement of the additional terms that apply to those files, or a notice indicating where to find the applicable terms.

Additional terms, permissive or non-permissive, may be stated in the form of a separately written license, or stated as exceptions; the above requirements apply either way.

8. Termination.
You may not propagate or modify a covered work except as expressly provided under this License. Any attempt otherwise to propagate or modify it is void, and will automatically terminate your rights under this License (including any patent licenses granted under the third paragraph of section 11).

However, if you cease all violation of this License, then your license from a particular copyright holder is reinstated (a) provisionally, unless and until the copyright holder explicitly and finally terminates your license, and (b) permanently, if the copyright holder fails to notify you of the violation by some reasonable means prior to 60 days after the cessation.

Moreover, your license from a particular copyright holder is reinstated permanently if the copyright holder notifies you of the violation by some reasonable means, this is the first time you have received notice of violation of this License (for any work) from that copyright holder, and you cure the violation prior to 30 days after your receipt of the notice.

Termination of your rights under this section does not terminate the licenses of parties who have received copies or rights from you under this License. If your rights have been terminated and not permanently reinstated, you do not qualify to receive new licenses for the same material under section 10.

9. Acceptance Not Required for Having Copies.
You are not required to accept this License in order to receive or run a copy of the Program. Ancillary propagation of a covered work occurring solely as a consequence of using peer-to-peer transmission to receive a copy likewise does not require acceptance. However, nothing other than this License grants you permission to propagate or modify any covered work. These actions infringe copyright if you do not accept this License. Therefore, by modifying or propagating a covered work, you indicate your acceptance of this License to do so.

10. Automatic Licensing of Downstream Recipients.
Each time you convey a covered work, the recipient automatically receives a license from the original licensors, to run, modify and propagate that work, subject to this License. You are not responsible for enforcing compliance by third parties with this License.

An “entity transaction” is a transaction transferring control of an organization, or substantially all assets of one, or subdividing an organization, or merging organizations. If propagation of a covered work results from an entity transaction, each party to that transaction who receives a copy of the work also receives whatever licenses to the work the party's predecessor in interest had or could give under the previous paragraph, plus a right to possession of the Corresponding Source of the work from the predecessor in interest, if the predecessor has it or can get it with reasonable efforts.

You may not impose any further restrictions on the exercise of the rights granted or affirmed under this License. For example, you may not impose a license fee, royalty, or other charge for exercise of rights granted under this License, and you may not initiate litigation (including a cross-claim or counterclaim in a lawsuit) alleging that any patent claim is infringed by making, using, selling, offering for sale, or importing the Program or any portion of it.

11. Patents.
A “contributor” is a copyright holder who authorizes use under this License of the Program or a work on which the Program is based. The work thus licensed is called the contributor's “contributor version”.

A contributor's “essential patent claims” are all patent claims owned or controlled by the contributor, whether already acquired or hereafter acquired, that would be infringed by some manner, permitted by this License, of making, using, or selling its contributor version, but do not include claims that would be infringed only as a consequence of further modification of the contributor version. For purposes of this definition, “control” includes the right to grant patent sublicenses in a manner consistent with the requirements of this License.

Each contributor grants you a non-exclusive, worldwide, royalty-free patent license under the contributor's essential patent claims, to make, use, sell, offer for sale, import and otherwise run, modify and propagate the contents of its contributor version.

In the following three paragraphs, a “patent license” is any express agreement or commitment, however denominated, not to enforce a patent (such as an express permission to practice a patent or covenant not to sue for patent infringement). To “grant” such a patent license to a party means to make such an agreement or commitment not to enforce a patent against the party.

If you convey a covered work, knowingly relying on a patent license, and the Corresponding Source of the work is not available for anyone to copy, free of charge and under the terms of this License, through a publicly available network server or other readily accessible means, then you must either (1) cause the Corresponding Source to be so available, or (2) arrange to deprive yourself of the benefit of the patent license for this particular work, or (3) arrange, in a manner consistent with the requirements of this License, to extend the patent license to downstream recipients. “Knowingly relying” means you have actual knowledge that, but for the patent license, your conveying the covered work in a country, or your recipient's use of the covered work in a country, would infringe one or more identifiable patents in that country that you have reason to believe are valid.

If, pursuant to or in connection with a single transaction or arrangement, you convey, or propagate by procuring conveyance of, a covered work, and grant a patent license to some of the parties receiving the covered work authorizing them to use, propagate, modify or convey a specific copy of the covered work, then the patent license you grant is automatically extended to all recipients of the covered work and works based on it.

A patent license is “discriminatory” if it does not include within the scope of its coverage, prohibits the exercise of, or is conditioned on the non-exercise of one or more of the rights that are specifically granted under this License. You may not convey a covered work if you are a party to an arrangement with a third party that is in the business of distributing software, under which you make payment to the third party based on the extent of your activity of conveying the work, and under which the third party grants, to any of the parties who would receive the covered work from you, a discriminatory patent license (a) in connection with copies of the covered work conveyed by you (or copies made from those copies), or (b) primarily for and in connection with specific products or compilations that contain the covered work, unless you entered into that arrangement, or that patent license was granted, prior to 28 March 2007.

Nothing in this License shall be construed as excluding or limiting any implied license or other defenses to infringement that may otherwise be available to you under applicable patent law.

12. No Surrender of Others' Freedom.
If conditions are imposed on you (whether by court order, agreement or otherwise) that contradict the conditions of this License, they do not excuse you from the conditions of this License. If you cannot convey a covered work so as to satisfy simultaneously your obligations under this License and any other pertinent obligations, then as a consequence you may not convey it at all. For example, if you agree to terms that obligate you to collect a royalty for further conveying from those to whom you convey the Program, the only way you could satisfy both those terms and this License would be to refrain entirely from conveying the Program.

13. Use with the GNU Affero General Public License.
Notwithstanding any other provision of this License, you have permission to link or combine any covered work with a work licensed under version 3 of the GNU Affero General Public License into a single combined work, and to convey the resulting work. The terms of this License will continue to apply to the part which is the covered work, but the special requirements of the GNU Affero General Public License, section 13, concerning interaction through a network will apply to the combination as such.

14. Revised Versions of this License.
The Free Software Foundation may publish revised and/or new versions of the GNU General Public License from time to time. Such new versions will be similar in spirit to the present version, but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number. If the Program specifies that a certain numbered version of the GNU General Public License “or any later version” applies to it, you have the option of following the terms and conditions either of that numbered version or of any later version published by the Free Software Foundation. If the Program does not specify a version number of the GNU General Public License, you may choose any version ever published by the Free Software Foundation.

If the Program specifies that a proxy can decide which future versions of the GNU General Public License can be used, that proxy's public statement of acceptance of a version permanently authorizes you to choose that version for the Program.

Later license versions may give you additional or different permissions. However, no additional obligations are imposed on any author or copyright holder as a result of your choosing to follow a later version.

15. Disclaimer of Warranty.
THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM “AS IS” WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

16. Limitation of Liability.
IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MODIFIES AND/OR CONVEYS THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

17. Interpretation of Sections 15 and 16.
If the disclaimer of warranty and limitation of liability provided above cannot be given local legal effect according to their terms, reviewing courts shall apply local law that most closely approximates an absolute waiver of all civil liability in connection with the Program, unless a warranty or assumption of liability accompanies a copy of the Program in return for a fee.

END OF TERMS AND CONDITIONS

How to Apply These Terms to Your New Programs

If you develop a new program, and you want it to be of the greatest possible use to the public, the best way to achieve this is to make it free software which everyone can redistribute and change under these terms.

To do so, attach the following notices to the program. It is safest to attach them to the start of each source file to most effectively state the exclusion of warranty; and each file should have at least the “copyright” line and a pointer to where the full notice is found.

     <one line to give the program's name and a brief idea of what it does.>
     Copyright (C) <year>  <name of author>

     This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

     This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

     You should have received a copy of the GNU General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.

Also add information on how to contact you by electronic and paper mail.

If the program does terminal interaction, make it output a short notice like this when it starts in an interactive mode:

     <program>  Copyright (C) <year>  <name of author>
     This program comes with ABSOLUTELY NO WARRANTY; for details type `show w'.
     This is free software, and you are welcome to redistribute it under certain conditions; type `show c' for details.

The hypothetical commands `show w' and `show c' should show the appropriate parts of the General Public License. Of course, your program's commands might be different; for a GUI interface, you would use an “about box”.

You should also get your employer (if you work as a programmer) or school, if any, to sign a “copyright disclaimer” for the program, if necessary. For more information on this, and how to apply and follow the GNU GPL, see <https://www.gnu.org/licenses/>.

The GNU General Public License does not permit incorporating your program into proprietary programs. If your program is a subroutine library, you may consider it more useful to permit linking proprietary applications with the library. If this is what you want to do, use the GNU Lesser General Public License instead of this License. But first, please read <https://www.gnu.org/philosophy/why-not-lgpl.html>.

--- PROJECT ATTRIBUTION NOTICE (GPLv3 section 7(b)) ---
# Licence and author attribution

Copyright © 2026 Paul Wood FRSA.

This project's original code and documentation are licensed under the GNU General Public License, version 3 only ([LICENSE](LICENSE)), with the following additional term permitted by GPLv3 section 7(b). The GPL text itself is unchanged.

## Additional term under section 7(b)

For material authored by Paul Wood FRSA, preserve the following author attribution in that material and in the Appropriate Legal Notices displayed by interactive works containing it:

> Paul Wood FRSA (paultendo on GitHub)
>
> https://github.com/paultendo

An accessible Help, About or equivalent legal-notices area is sufficient. Retain the profile link where hyperlinks are supported. No particular screen position, credit on every screen, advertising credit or donation link is required. This term applies to works containing the attributed material, not unrelated programs distributed alongside them.

You may add other author and contributor credits. This attribution does not imply endorsement of modified versions.

## Working with this project

Keep this notice with the source when redistributing it, alongside the GPL licence and copyright notices. The standalone userscript includes both the licence and this notice. Contributions are accepted on the terms described in [CONTRIBUTING.md](CONTRIBUTING.md); contributors retain copyright in their own work. Third-party components keep their own licences and notices.

You may use the project commercially. If you distribute a modified covered version, GPLv3 requires licensing it under the GPL and providing its corresponding source to recipients in a GPL-compliant way. You do not have to publish private changes or use a public GitHub repository. See LICENSE for the binding terms.
END ATTACHMENT BATCH LICENCE */
