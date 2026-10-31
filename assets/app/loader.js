/* Bootstrap one isolated local project. Browser storage is never a source of truth. */
(() => {
  'use strict';
  const KEY = 'shouzhang_v2_qa_skill';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const listeners = new Set();
  let boot, revision = 0, sequence = 0, acknowledged = 0, running = null, lastError = null, timer = null;
  const values = new Map();
  const sync = {
    phase: 'loading', message: '正在打开本机项目',
    get revision() { return revision; },
    get pending() { return sequence !== acknowledged; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    retry() { lastError = null; return flush(); },
    async whenIdle() { if (sync.pending) await flush(); if (sync.pending) throw Error(lastError || '仍有更改未保存，请重试保存或导出当前记录。'); }
  };
  function notify(phase, message) {
    sync.phase = phase; sync.message = message;
    const J = window.Journal;
    if (J) {
      J.status.message = message; J.status.dirty = sync.pending;
      J.status.writeError = phase === 'error' ? message : null;
      if (phase === 'saved') J.status.savedAt = new Date().toISOString();
    }
    listeners.forEach(fn => { try { fn(sync); } catch (_) {} });
  }
  const storage = {
    asynchronous: true,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      values.set(key, String(value));
      if (key !== KEY) return;
      sequence++; lastError = null;
      notify('saving', '正在保存到本机项目…');
      queueMicrotask(() => flush());
    }
  };
  async function request(path, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(path, {cache:'no-store', credentials:'same-origin', ...options, signal:controller.signal});
      let body; try { body = await response.json(); } catch (_) { throw Error('本机服务没有返回有效数据。'); }
      if (!response.ok && response.status !== 409) throw Error(body.error || body.message || '本机服务暂时不可用（' + response.status + '）。');
      return {response, body};
    } finally { clearTimeout(timeout); }
  }
  function flush() {
    if (running) return running;
    running = (async () => {
      let conflicts = 0;
      try {
        while (acknowledged !== sequence) {
          const sent = sequence, user = JSON.parse(storage.getItem(KEY));
          notify('saving', '正在保存到本机项目…');
          const {response, body} = await request('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({base_revision:revision, user})});
          if (response.status === 409) {
            if (conflicts++ >= 1 || !body.user || !Number.isInteger(body.revision)) throw Error('另一页面也有新更改。本页记录已保留，请重试保存；不会覆盖较新的记录。');
            revision = body.revision;
            const J = window.Journal, preview = J.prepareImport({user:body.user});
            if (!preview.ok) throw Error('另一页面的记录暂不能合并，本页更改已保留。');
            const result = J.commitImport(preview);
            if (!result.ok) throw Error(result.errors.join('；'));
            window.JournalUI?.render();
            continue;
          }
          if (body.ok !== true || !Number.isInteger(body.revision)) throw Error('尚未确认保存完成，请重试。');
          revision = body.revision; acknowledged = sent; conflicts = 0;
        }
        lastError = null; notify('saved', '已保存到本机项目');
      } catch (error) {
        lastError = error.name === 'AbortError' ? '保存连接超时，本页更改仍在。' : error.message;
        notify('error', '尚未保存 · ' + lastError);
      } finally { running = null; }
    })();
    return running;
  }
  function script(name) {
    return new Promise((resolve,reject) => { const node=document.createElement('script'); node.src=name; node.onload=resolve; node.onerror=()=>reject(Error('页面组件未能载入：'+name)); document.body.append(node); });
  }
  function progressView(progress = {}) {
    const box=document.getElementById('collection-status');
    const state=String(progress.run_state || progress.status || progress.state || ''), complete=Number(progress.completed_count ?? progress.captured_count ?? progress.order_count ?? progress.captured ?? progress.orders ?? progress.done ?? 0);
    const total=Number(progress.total_count ?? progress.total ?? 0), qualityPending=Number(progress.pending_quality_count || 0);
    const message=String(progress.message || progress.note || (qualityPending>0?'订单已收录。':''))+(qualityPending>0?' 仍有 '+qualityPending+' 处金额或状态待核。':'');
    const active=Boolean(progress.running || progress.paused) || ['running','collecting','paused','waiting_login','login_required','blocked','complete_with_pending'].includes(state);
    box.innerHTML=active||message ? '<div class="notice collection-progress"><strong>'+esc(message || (state==='paused'?'采集已暂停，可从上次位置继续。':'正在按时间补齐你的订单。'))+'</strong>'+(Number.isFinite(complete)&&complete>0?'<span class="small muted"> 已收录 '+complete+(total>0?' / '+total:'')+' 笔</span>':'')+'</div>' : '';
    return active;
  }
  function historyDialog(title, html) {
    document.getElementById('modal-title').textContent=title;
    document.getElementById('modal-body').innerHTML=html;
    if(!document.getElementById('modal').open)document.getElementById('modal').showModal();
  }
  window.JournalHistory = {
    async open() {
      try {
        const {body}=await request('/api/backups');
        const rows=Array.isArray(body)?body:(body.backups||body.snapshots||[]);
        historyDialog('恢复历史记录', '<p class="small muted">恢复前会保留当前版本。原始订单不会被改写。</p>'+ (rows.length?rows.map(row=>'<div class="versions"><strong>'+esc(row.created_at||row.at||row.id)+'</strong><br>'+esc(row.reason||'自动保存的历史版本')+' <button class="text-btn" data-restore-snapshot="'+esc(row.id)+'">恢复这个版本</button></div>').join(''):'<p>尚无历史版本；首次修改后会自动保留。</p>'));
      } catch(error) { historyDialog('历史暂时打不开', '<p>'+esc(error.message)+'</p>'); }
    }
  };
  document.addEventListener('click', async event => {
    const button=event.target.closest?.('[data-restore-snapshot]'); if(!button)return;
    button.disabled=true;
    try {
      await sync.whenIdle();
      const {response,body}=await request('/api/backups/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.restoreSnapshot,base_revision:revision})});
      if(response.status===409)throw Error('其他页面刚有新更改，请关闭对话框、重试保存后再恢复历史。');
      if(body.ok!==true)throw Error('恢复尚未完成。');
      location.reload();
    } catch(error) { historyDialog('记录已保留，暂未恢复','<p>'+esc(error.message)+'</p>'); }
  });
  window.addEventListener('beforeunload', event => { if(sync.pending){event.preventDefault();event.returnValue='';} });
  async function poll() {
    try {
      const {body}=await request('/api/bootstrap');progressView(body.progress);
      const fingerprint=value=>JSON.stringify([value?.data?.meta?.data_version,value?.data?.orders?.length,value?.reports]);
      const changed=fingerprint(body)!==fingerprint(boot);
      const editing=document.activeElement?.matches('input,textarea,select')||document.getElementById('modal').open;
      if(changed&&!editing&&!sync.pending&&!document.hidden){location.reload();return;}
    } catch(_) { /* Collection can reconnect; never discard unsaved edits. */ }
    timer=setTimeout(poll,15000);
  }
  async function start() {
    try {
      ({body:boot}=await request('/api/bootstrap'));
      if(!boot.project||!boot.data||!Array.isArray(boot.data.orders)||!boot.user||!Number.isInteger(boot.revision))throw Error('本机项目尚未准备好，请稍后重试。');
      revision=boot.revision;values.set(KEY,JSON.stringify(boot.user));
      window.JOURNAL_PROJECT=boot.project;window.JOURNAL_SYNC=sync;window.JOURNAL_STORAGE_KEY=KEY;window.JOURNAL_STORAGE=storage;
      window.ORDERS_DATA={...boot.data,meta:{...(boot.data.meta||{}),range_start:boot.project.range_start||boot.data.meta?.range_start||'',range_end:boot.project.range_end||boot.data.meta?.range_end||'',advice_year:boot.project.advice_year}};
      window.JOURNAL_REPORTS=boot.reports||{monthly:{},annual:{}};
      document.title=boot.project.title||'我的消费手账';
      document.getElementById('project-range').textContent=[boot.project.range_start,boot.project.range_end].filter(Boolean).join(' — ')||'私人手账';
      progressView(boot.progress);
      for(const name of ['core.js','personality.js','year_plan.js','app.js'])await script(name);
      if(window.Journal.status.storageBlocked)notify('error','记录未能安全读取。请导出并保留当前项目，联系助手检查。');
      else notify('saved','已保存到本机项目');
      timer=setTimeout(poll,15000);
    } catch(error) {
      document.getElementById('save-status').textContent='项目尚未打开';
      document.getElementById('main').innerHTML='<div class="empty"><p>'+esc(error.name==='AbortError'?'本机服务连接超时，请重试。':error.message)+'</p><button class="btn" id="retry-start">重新打开</button></div>';
      document.getElementById('retry-start').onclick=()=>location.reload();
    }
  }
  start();
})();
