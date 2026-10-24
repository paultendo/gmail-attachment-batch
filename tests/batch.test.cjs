'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
const api = require('../gmail-attachment-batch.user.js');
const root = 'https://mail.google.com/mail/u/1/';
const id1 = '18abc00000000001', id2 = '18abc00000000002';
const q = '#search/from%3Aduncan%40example.test%20has%3Aattachment';
function doc(html) { return parseHTML('<html><body>'+html+'</body></html>').document; }
function row(id, subject='Report') { return `<tr class="zA" role="row"><td><span email="sender@example.test" name="Sender">Sender</span><span data-legacy-thread-id="${id}"></span><span class="bog">${subject}</span></td></tr>`; }
function list(rows) { return `<main role="main"><table><tbody>${rows}</tbody></table></main>`; }
function tile(message=id1, part='0.1', filename='Report.pdf', raw) {
  const url = raw || `application/pdf:${filename}:https://mail.google.com/mail/u/1/?view=att&amp;th=${message}&amp;attid=${part}&amp;disp=attd`;
  return `<div data-legacy-message-id="${message}"><div class="aQH"><span class="aZo" download_url="${url}"><span class="aV3">${filename}</span></span></div></div>`;
}

test('reads executed search query and page, never silently falls back to inbox', () => {
  assert.equal(api.searchState(root+q+'/p3').page,3);
  assert.equal(api.searchState(root+q).query,'from:duncan@example.test has:attachment');
  assert.equal(api.searchState(root+'#search/from%3Aduncan+has%3Aattachment+%2Btag').query,'from:duncan has:attachment +tag');
  assert.throws(()=>api.searchState(root+'#inbox'), /Run a Gmail search/);
  assert.throws(()=>api.searchState(root+q+'/'+id1), /results list/);
});
test('captures distinct result IDs and fails closed on unidentifiable rows', () => {
  assert.equal(api.resultRows(doc(list(row(id1)+row(id1)+row(id2)))).length,2);
  assert.throws(()=>api.resultRows(doc(list('<tr class="zA"><td>Unknown row</td></tr>'))),/could not be identified/);
});
test('supports the decimal thread identifiers used by Gmail', () => {
  const d=doc(list(`<tr class="zA"><td><span data-thread-id="#thread-f:${BigInt('0x'+id1)}|msg-f:123"></span><span class="bog">X</span></td></tr>`));
  assert.equal(api.resultRows(d)[0].id,id1);
});
test('grouped Gmail threads retain native identity and verify the visible header without relying on a message URL', () => {
  const native='thread-a:r-123456789';
  const d=doc(list(`<tr class="zA"><td><span data-thread-id="#${native}|msg-f:123" data-legacy-message-id="${id1}"></span><span class="bog">Grouped conversation</span></td></tr>`));
  const ref=api.resultRows(d)[0];assert.equal(ref.nativeThreadId,native);assert.equal(ref.kind,'thread');
  assert.equal(api.isExpectedThread(doc(`<main role="main"><h2 data-thread-perm-id="${native}">Grouped conversation</h2></main>`),ref),true);
  assert.equal(api.isExpectedThread(doc('<main role="main"><h2 data-thread-perm-id="thread-a:other">Grouped conversation</h2></main>'),ref),false);
  assert.equal(api.isExpectedThread(doc(`<main role="main"><div class="a3s"><h2 data-thread-perm-id="${native}">Spoofed</h2></div></main>`),ref),false);
});

test('hidden inbox panes cannot bleed into the search snapshot', () => {
  const d=doc(`<main role="main" hidden><table>${row(id2)}</table></main>`+list(row(id1)));
  assert.deepEqual(api.resultRows(d).map(x=>x.id),[id1]);
});
test('attachment identity distinguishes identical names in different emails and parts', () => {
  const d=doc(`<main role="main">${tile(id1,'0.1')}${tile(id1,'0.2')}${tile(id2,'0.1')}${tile(id1,'0.1')}</main>`);
  const result=api.collectAttachments(d,{id:id1},root);
  assert.equal(result.files.length,3); assert.equal(result.issues.length,0);
});
test('download links are restricted to the expected Google hosts/account', () => {
  assert.throws(()=>api.attachmentUrl('application/pdf:x:https://evil.test/?view=att',root),/No supported/);
  assert.throws(()=>api.attachmentUrl('https://mail.google.com.evil.test/?view=att',root),/No supported/);
  assert.throws(()=>api.attachmentUrl('https://mail.google.com/mail/u/0/?view=att',root),/another Gmail account/);
  assert.throws(()=>api.attachmentUrl('https://mail.google.com/mail/u/1/#inbox',root),/No supported/);
});
test('Drive links and unsupported tiles are recorded rather than counted as saved', () => {
  const d=doc('<main role="main"><div class="aQH"><span class="aZo"><span class="aV3">Linked file</span></span><a href="https://drive.google.com/file/d/123">Drive</a></div></main>');
  const r=api.collectAttachments(d,{id:id1},root);
  assert.equal(r.files.length,0); assert.equal(r.issues.length,2);
});
test('message-body HTML cannot impersonate attachment tiles or navigation controls', () => {
  const d=doc(`<main role="main"><div class="a3s">${tile(id1)}<button aria-label="Expand all">Fake control</button><h2 data-legacy-thread-id="${id1}">Fake header</h2></div></main>`);
  assert.equal(api.collectAttachments(d,{id:id1},root).files.length,0);
  assert.equal(api.control(d,/^Expand all$/),undefined);
  assert.equal(api.isExpectedThread(d,{id:id1,kind:'thread'}),false);
});
test('filenames cannot create paths or reserved Windows names', () => {
  assert.equal(api.safeFilename('../../CON.pdf'),'_.._CON.pdf');
  assert.equal(api.safeFilename('CON.pdf'),'_CON.pdf');
  assert.equal(api.safeFilename('a/b\\c: report?.pdf'),'a_b_c_ report_.pdf');
  assert.throws(()=>api.safeFilename('...'),/no usable/);
  assert.ok(api.safeFilename('a'.repeat(200)+'.pdf').length<110);
});
test('folder paths are bounded, safe and keep same-subject threads and same-name files distinct', () => {
  assert.equal(api.batchFolderName('sample documents',new Date('2026-10-24T09:00:00Z')),'2026-10-24_10-00-00_sample-documents');
  assert.equal(api.safeFolder('../CON: test / \\ *'),'_CON_ test _ _ _');
  assert.equal(api.safeFolder('CON'),'_CON'); assert.equal(api.safeFolder('..'),'Untitled');
  const file={filename:'CON.foo.pdf'},ref={id:id1,subject:'../../Thread: one?'};
  const path=api.attachmentPath('../My batch','threads',ref,file,0);
  assert.equal(path.split('/').length,4); assert.ok(path.startsWith('Gmail attachments/'));
  assert.ok(path.split('/').every(part=>part && part!=='.' && part!=='..' && !/[<>:"\\|?*]/.test(part)));
  assert.match(path,/_CON\.foo\.pdf$/);
  assert.notEqual(path,api.attachmentPath('../My batch','threads',{...ref,id:id2},file,0));
  assert.notEqual(path,api.attachmentPath('../My batch','threads',ref,file,1));
  assert.equal(api.attachmentPath('Batch','flat',ref,file,0).split('/').length,3);
  const long=api.attachmentPath('界'.repeat(100),'threads',{id:id1,subject:'界'.repeat(100)},{filename:'界'.repeat(100)+'.pdf'},0);
  assert.ok(Buffer.byteLength(long)<250); assert.ok(long.endsWith('.pdf'));
});

test('CSV neutralises spreadsheet formulas and never exports signed URLs', () => {
  const csv=api.reportCsv({snapshot:{query:'from:example'},log:[{subject:'=1+2',filename:'file.pdf',status:'saved',url:'https://secret.test/token'}]});
  assert.match(csv,/'=1\+2/); assert.doesNotMatch(csv,/secret\.test/);
});
test('CSV accounts for discovered-but-unattempted files and unopened conversations', () => {
  const csv=api.reportCsv({snapshot:{query:'x',refs:[{id:id1,subject:'Opened',selected:true},{id:id2,subject:'Pending',selected:true}]},log:[],visited:new Set([id1]),planned:new Map([['k',{attachment_key:'k',filename:'pending.pdf',status:'not_attempted'}]])});
  assert.match(csv,/not_attempted/); assert.match(csv,/not_processed/); assert.match(csv,/pending.pdf/);
});
test('a started download is not treated as completed before onload', async () => {
  let callbacks, resolved=false;
  const promise=api.downloadOne(options=>{callbacks=options;return{abort(){}};},{url:'https://mail.google.com/x'},'x.pdf',()=>{},1000).then(()=>{resolved=true;});
  await new Promise(r=>setImmediate(r)); assert.equal(resolved,false);
  callbacks.onload(); await promise; assert.equal(resolved,true);
});
test('synchronous errors, asynchronous failures and stop without callbacks terminate', async () => {
  await assert.rejects(api.downloadOne(()=>{throw Error('disabled');},{url:'x'},'x.pdf',()=>{}),/disabled/);
  await assert.rejects(api.downloadOne(o=>{queueMicrotask(()=>o.onerror({error:'not_permitted'}));return{};},{url:'x'},'x.pdf',()=>{}),/permission is missing/);
  let control;
  const p=api.downloadOne(()=>({abort(){}}),{url:'x'},'x.pdf',h=>{if(h)control=h;});
  control.abort(); await assert.rejects(p,e=>e.unknown===true);
});
test('timeout creates an unknown outcome and ignores a late completion callback', async () => {
  let options, aborted=false;
  const p=api.downloadOne(o=>{options=o;return{abort(){aborted=true;}};},{url:'x'},'x.pdf',()=>{},8);
  await assert.rejects(p,e=>e.unknown===true); assert.equal(aborted,true);
  options.onload(); // A late callback cannot change the settled outcome.
});

test('Gmail toolbar survives navigation and panel mounts with Trusted Types HTML sinks blocked', async () => {
  const {window}=parseHTML('<html><body><div role="toolbar" aria-label="search refinement"></div><div gh="tm"><div class="G-tF"><button aria-label="Refresh">Refresh</button><button aria-label="More email options">More</button></div></div><main role="main"></main></body></html>');
  window.__GMAIL_BATCH_DEMO__=true; window.__GMAIL_BATCH_HREF__=root+q;
  Object.defineProperty(window.ShadowRoot.prototype,'innerHTML',{configurable:true,set(){throw Error('TrustedHTML required');}});
  const controller=api.mount(window), toolbar=window.document.querySelector('.G-tF');
  assert.equal(controller.toolbarGroup.parentElement,toolbar);
  assert.equal(controller.shadow.querySelector('#launch'),null);
  assert.equal(window.document.querySelector('[aria-label="search refinement"]').children.length,0);
  controller.toolbarButton.click(); assert.equal(controller.shadow.querySelector('#panel').hidden,false);
  controller.helpButton.click(); assert.equal(controller.shadow.querySelector('#help').hidden,false); assert.equal(controller.shadow.querySelector('#panel').hidden,true);
  const helpLinks=[...controller.shadow.querySelectorAll('#help a')].map(a=>a.getAttribute('href'));
  assert.ok(helpLinks.includes('https://github.com/paultendo')); assert.ok(helpLinks.includes('https://buymeacoffee.com/paultendo'));
  assert.ok(helpLinks.includes('https://github.com/paultendo/gmail-attachment-batch'));
  assert.ok(helpLinks.includes('https://github.com/paultendo/gmail-attachment-batch/issues'));
  controller.shadow.getElementById('help-back').click(); assert.equal(controller.shadow.querySelector('#help').hidden,true); assert.equal(controller.shadow.querySelector('#panel').hidden,false);
  toolbar.remove(); const replacement=window.document.createElement('div'); replacement.className='G-tF'; replacement.innerHTML='<button aria-label="Refresh">Refresh</button>'; window.document.querySelector('[gh="tm"]').append(replacement);
  await new Promise(r=>setImmediate(r)); assert.equal(controller.toolbarGroup.parentElement,replacement);
  window.__GMAIL_BATCH_HREF__=root+'#inbox'; window.dispatchEvent(new window.Event('hashchange'));
  assert.equal(controller.toolbarGroup.isConnected,false); controller.dispose();
  delete window.ShadowRoot.prototype.innerHTML;
});

test('toolbar centres on Gmail controls without accumulating offsets after resize', () => {
  const {window}=parseHTML('<html><body><div gh="tm"><div class="G-tF"><button aria-label="Refresh">Refresh</button></div></div></body></html>');
  window.__GMAIL_BATCH_DEMO__=true;window.__GMAIL_BATCH_HREF__=root+q;
  const c=api.mount(window), refresh=window.document.querySelector('[aria-label="Refresh"]');
  let nativeTop=10;
  refresh.getBoundingClientRect=()=>({top:nativeTop,height:20});
  c.toolbarGroup.getBoundingClientRect=()=>({top:20+Number(c.toolbarGroup.style.transform?.match(/translateY\(([-\d.]+)px\)/)?.[1]||0),height:32});
  window.dispatchEvent(new window.Event('resize'));assert.equal(c.toolbarGroup.style.transform,'translateY(-16px)');
  window.dispatchEvent(new window.Event('resize'));assert.equal(c.toolbarGroup.style.transform,'translateY(-16px)');
  nativeTop=14;window.dispatchEvent(new window.Event('resize'));assert.equal(c.toolbarGroup.style.transform,'translateY(-12px)');
  c.dispose();nativeTop=30;window.dispatchEvent(new window.Event('resize'));assert.equal(c.toolbarGroup.style.transform,'translateY(-12px)');
});

test('table review filters, pages, sorts and changes only matching selections', () => {
  const {window}=parseHTML('<html><body></body></html>');
  window.__GMAIL_BATCH_DEMO__=true; window.__GMAIL_BATCH_HREF__=root+q;
  const c=api.mount(window), $=id=>c.shadow.getElementById(id);
  c.state.snapshot={query:'x',refs:Array.from({length:60},(_,i)=>({id:String(i),subject:`Subject ${String(i).padStart(2,'0')}`,sender:i<30?'alice@example.test':'bob@example.test',date:'22 Oct 2026',selected:true})),pages:2,complete:true};
  c.showRows(); assert.equal(c.shadow.querySelectorAll('tbody tr').length,5);
  $('expand').click(); assert.equal(c.shadow.querySelectorAll('tbody tr').length,25);
  $('review-next').click(); assert.match($('review-range').textContent,/26–50 of 60/);
  $('review-filter').value='alice'; $('review-filter').dispatchEvent(new window.Event('input'));
  assert.equal(c.filteredRefs().length,30); assert.match($('review-range').textContent,/1–25 of 30 matching/);
  $('exclude-matching').click(); assert.equal(c.state.snapshot.refs.filter(r=>r.selected).length,30);
  assert.ok(c.state.snapshot.refs.slice(30).every(r=>r.selected));
  c.state.reviewSort='subject'; assert.equal(c.filteredRefs()[0].subject,'Subject 00');
  c.state.busy=true; $('select-matching').click(); assert.equal(c.state.snapshot.refs.filter(r=>r.selected).length,30);
  c.dispose();
});

test('folder setup is explained when required and hidden once enabled', () => {
  const make=()=>{const {window}=parseHTML('<html><body></body></html>');window.__GMAIL_BATCH_DEMO__=true;window.__GMAIL_BATCH_HREF__=root+q;return api.mount(window);};
  try {
    global.GM_info={downloadMode:'native'}; const needed=make();
    assert.equal(needed.shadow.getElementById('download-setup').hidden,false);
    assert.match(needed.shadow.getElementById('download-setup').textContent,/Enable folder downloads/);
    assert.equal(needed.shadow.getElementById('download').disabled,true); needed.dispose();
    global.GM_info={downloadMode:'browser'}; const ready=make();
    assert.equal(ready.shadow.getElementById('download-setup').hidden,true); ready.dispose();
  } finally {delete global.GM_info;}
});

test('setup check saves only a local test file, preserves batch records and explains permission failures', async () => {
  const oldInfo=global.GM_info, oldDownload=global.GM_download;
  const {window}=parseHTML('<html><body></body></html>');
  window.__GMAIL_BATCH_DEMO__=true; window.__GMAIL_BATCH_HREF__=root+q;
  global.GM_info={downloadMode:'browser'};
  const c=api.mount(window); let calls=0, outcome='success', release;
  global.GM_download=options=>{
    calls++; assert.equal(options.name,'Gmail attachments/setup-check.txt'); assert.ok(options.url instanceof Blob);
    assert.equal(options.saveAs,false);
    options.url.text().then(value=>{assert.match(value,/No email data/);});
    release=()=>outcome==='success'?options.onload():options.onerror({error:outcome});
    return {abort(){}};
  };
  try {
    c.state.done.add('existing-file'); c.state.log.push({status:'saved'});
    const first=c.checkSetup(); assert.equal(c.state.checkingSetup,true);
    await c.checkSetup(); await c.capture(); await c.run(); assert.equal(calls,1); assert.equal(c.state.snapshot,null);
    release(); await first; assert.match(c.shadow.getElementById('setup-status').textContent,/Demo check passed.*No real file/);
    assert.equal(c.state.done.size,1); assert.equal(c.state.log.length,1);
    for (const [error,expected] of [['not_permitted',/permission is missing/],['not_whitelisted',/blocked \.txt/],['not_enabled',/Downloads are switched off/],['not_supported',/Update Chrome/],['not_succeeded',/not confirmed saved/]]) {
      outcome=error; const next=c.checkSetup(); release(); await next;
      assert.match(c.shadow.getElementById('setup-status').textContent,expected); assert.equal(c.state.checkingSetup,false);
    }
    global.GM_info={downloadMode:'native'}; await c.checkSetup(); assert.equal(calls,6);
  } finally { c.dispose(); if(oldInfo===undefined)delete global.GM_info;else global.GM_info=oldInfo; if(oldDownload===undefined)delete global.GM_download;else global.GM_download=oldDownload; }
});

test('Help topics are separate accessible panels and support keyboard tab navigation', () => {
  const {window}=parseHTML('<html><body></body></html>');window.__GMAIL_BATCH_DEMO__=true;window.__GMAIL_BATCH_HREF__=root+q;
  const c=api.mount(window), $=id=>c.shadow.getElementById(id);
  c.helpButton.click(); assert.equal($('help').hidden,false);
  assert.equal($('help-page-setup').hidden,false); assert.equal($('help-page-fixes').hidden,true);
  $('help-tab-fixes').click(); assert.equal($('help-page-setup').hidden,true); assert.equal($('help-page-fixes').hidden,false);
  assert.equal($('help-tab-fixes').getAttribute('aria-selected'),'true');
  const key=new window.Event('keydown',{bubbles:true,cancelable:true});key.key='ArrowRight';$('help-tab-fixes').dispatchEvent(key);
  assert.equal($('help-page-about').hidden,false);assert.equal($('help-tab-about').getAttribute('tabindex'),'0');
  assert.ok($('help-page-about').textContent.includes('GPL version 3'));assert.ok($('help-page-about').textContent.includes('No warranty'));
  assert.equal(c.shadow.querySelectorAll('[role="tab"][aria-selected="true"]').length,1);
  assert.equal(c.shadow.querySelectorAll('[role="tabpanel"]:not([hidden])').length,1);
  $('help-back').click();assert.equal($('help').hidden,true);assert.equal($('panel').hidden,false);c.dispose();
});

test('download failures identify the file type and recovery while preserving the error code', async () => {
  for (const [code,expected] of [['not_whitelisted',/blocking \.pdf files.*Whitelisted File Extensions/],['not_permitted',/permission is missing/],['not_enabled',/switched off/],['not_supported',/Update Chrome/],['not_succeeded',/Check Chrome Downloads/]]) {
    await assert.rejects(api.downloadOne(o=>{queueMicrotask(()=>o.onerror({error:code}));return{};},{url:'x',filename:'Example.PDF'},'x.pdf',()=>{}),e=>e.code===code && expected.test(e.message) && !e.message.includes(code));
  }
  assert.match(api.downloadFailure('not_whitelisted','no-extension'),/blocking this file type/);
  assert.doesNotMatch(api.downloadFailure('https://secret.test/token'),/secret/);
  assert.equal(api.quantity(1,'file'),'1 file');assert.equal(api.quantity(2000,'file'),'2,000 files');
});

test('large review lists support page selection and reset filters without changing other pages', () => {
  const {window}=parseHTML('<html><body></body></html>');window.__GMAIL_BATCH_DEMO__=true;window.__GMAIL_BATCH_HREF__=root+q;
  const c=api.mount(window),$=id=>c.shadow.getElementById(id);
  c.state.snapshot={query:'fixture',refs:Array.from({length:5000},(_,i)=>({id:String(i),subject:'Document '+i,sender:i%2?'alex@example.test':'sam@example.test',date:'24 Oct 2026',selected:false})),pages:100,complete:true};
  c.showRows();$('expand').click();
  const select=c.shadow.querySelector('thead input');select.checked=true;select.dispatchEvent(new window.Event('change'));
  assert.equal(c.state.snapshot.refs.filter(r=>r.selected).length,25);assert.ok(c.state.snapshot.refs.slice(25).every(r=>!r.selected));
  $('review-next').click();assert.equal(c.shadow.querySelector('thead input').checked,false);
  $('review-filter').value='alex@';$('review-filter').dispatchEvent(new window.Event('input'));assert.equal(c.filteredRefs().length,2500);assert.equal($('review-reset').hidden,false);
  $('review-reset').click();assert.equal(c.filteredRefs().length,5000);assert.equal(c.state.snapshot.refs.filter(r=>r.selected).length,25);assert.equal($('review-reset').hidden,true);
  assert.match($('selection').textContent,/of 5,000 conversations selected/);c.dispose();
});

test('full synthetic run captures two pages, handles permanent routes, downloads both, and skips completed files on re-run', async () => {
  const {window}=parseHTML('<html><body><main role="main"></main></body></html>');
  window.__GMAIL_BATCH_DEMO__=true; window.__GMAIL_BATCH_HREF__=root+q;
  const main=window.document.querySelector('main');
  let calls=0, requested=[];
  function navigate(hash){
    window.__GMAIL_BATCH_HREF__=root+hash;
    if(hash.startsWith('#all/')) {
      const id=hash.slice(5); main.innerHTML=`<h2 data-legacy-thread-id="${id}">Report</h2>${tile(id)}`;
      window.__GMAIL_BATCH_HREF__=root+'#all/FMfcgzOpaque'+id;
    } else {
      const page=hash.endsWith('/p2')?2:1;
      main.innerHTML=`<table>${row(page===1?id1:id2)}</table><button aria-label="Older" ${page===2?'disabled':''}>Older</button>`;
      main.querySelector('button').addEventListener('click',()=>navigate(q+'/p2'));
      main.querySelector('tr').addEventListener('click',()=>navigate('#all/'+(page===1?id1:id2)));
    }
  }
  window.__GMAIL_BATCH_NAVIGATE__=navigate; navigate(q);
  global.GM_download=options=>{calls++;requested.push(options);queueMicrotask(options.onload);return{abort(){}};};
  const controller=api.mount(window);
  await controller.capture(); assert.equal(controller.state.snapshot.complete,true); assert.equal(controller.state.snapshot.refs.length,2);
  await controller.run(); assert.equal(calls,2); assert.equal(controller.state.done.size,2); assert.equal(controller.state.phase,'finished');
  await controller.run(); assert.equal(calls,2); assert.equal(controller.state.phase,'finished'); assert.deepEqual(controller.state.runSummary,{saved:0,alreadySaved:2,unknownSkipped:0,conversations:2}); assert.match(controller.state.message,/0 files saved; 2 already saved/);
  window.__GMAIL_BATCH_HREF__=root+'#search/something-else'; await controller.run(); assert.equal(calls,2); assert.match(controller.state.message,/captured search/);
  controller.shadow.getElementById('report').click(); await new Promise(r=>setImmediate(r));
  assert.equal(calls,3); assert.match(requested.at(-1).name,/^Gmail attachments\/.+\/batch-report\.csv$/); assert.ok(requested.at(-1).url instanceof Blob);
  assert.equal(controller.state.reportSaving,false);
  delete global.GM_download;
});


test('background timer delays do not expire a ready Gmail view, and guards still run', async () => {
  let polls=0, guards=0;
  const value=await api.waitFor(()=>++polls===2 && 'ready',()=>guards++,1,()=>true);
  assert.equal(value,'ready');assert.equal(guards,2);
  await assert.rejects(api.waitFor(()=>false,()=>{throw new Error('account changed');},1,()=>true),/account changed/);
  await assert.rejects(api.waitFor(()=>false,()=>{},1,()=>false),/too long/);
});
