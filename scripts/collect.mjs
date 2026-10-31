/**
 * Script-first, serial Taobao collector. Agent owns the one Ego TaskSpace.
 * import {run} from './collect.mjs'; await run(task,{projectPath});
 * No browser is opened on import. No hidden APIs, credential reads or search.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {capturePage,captureDetail,mergeDetail} from './taobao_dom.mjs';
const execute=promisify(execFile),SCRIPT_DIR=path.dirname(fileURLToPath(import.meta.url));
const LIST_URL='https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
async function readJSON(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function atomic(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(obj,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);}
async function immutable(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(sha(await fs.readFile(file))!==sha(bytes))throw Error('immutable_source_changed');}}
class Stop extends Error {constructor(state,reason){super(reason);this.state=state;}}
function safeOrderURL(value){try{const u=new URL(value);return u.protocol==='https:'&&/(^|\.)(taobao|tmall)\.com$/.test(u.hostname)?u.href:null;}catch{return null;}}
function pendingItem(i){return !i.unit_paid_verified&&!/^(?:单件实付|单价实付|实付价|商品实付)\s*[:：]?\s*[¥￥]?\s*\d/m.test(i.paid_text||'');}
function safeError(error){return String(error?.message||error).replace(/https?:\/\/\S+/g,'[页面]').slice(0,250);}

export async function run(task,options={}) {
  if(!task?.page)throw Error('需要由Agent传入已管理的唯一Ego TaskSpace');
  const projectPath=options.projectPath?await fs.realpath(path.resolve(options.projectPath)):'';
  if(!options.projectPath||inside(path.dirname(SCRIPT_DIR),projectPath))throw Error('项目必须在Skill安装目录外');
  const config=await readJSON(path.join(projectPath,'project.json'),null);
  if(!config)throw Error('请先由Agent初始化私人项目（project.json缺失）');
  const checkpointFile=path.join(projectPath,'checkpoints','collection.json');
  const cp=await readJSON(checkpointFile,{version:1,run_state:'ready',completed_signatures:[],captured_orders:0,captured_items:0,detail_count:0,pending_count:0,last_navigation_at:0,completed:false});
  const maxPages=options.maxPages??Infinity;
  const navigationIntervalMs=options.navigationIntervalMs??4500;
  const detailPauseMs=options.detailPauseMs??8000;
  const detailsPerPause=options.detailsPerPause??5;
  const sleep=options.sleep??delay,now=options.now??Date.now;
  const log=options.onProgress??(value=>console.log(JSON.stringify(value)));
  const python=options.python||'python3';
  const subprocess=options.execute??(async(args)=>{const {stdout}=await execute(python,['-B',...args],{maxBuffer:2*1024*1024});return stdout?JSON.parse(stdout):{};});
  const emit=async()=>{const backendState=await subprocess([path.join(SCRIPT_DIR,'journal.py'),'status','--project',projectPath]).catch(()=>null);
    if(Number.isInteger(backendState?.pending_count))cp.pending_count=backendState.pending_count;
    const progress={run_state:cp.run_state,captured_orders:cp.captured_orders,captured_items:cp.captured_items,pending_count:cp.pending_count,pending_quality_count:cp.quality_issue_count||0,completed:cp.completed,last_page:cp.current_page??null,reason:cp.reason||null};
    await atomic(checkpointFile,cp);await atomic(path.join(projectPath,'checkpoints','progress.json'),progress);
    try{await subprocess([path.join(SCRIPT_DIR,'journal.py'),'progress','--project',projectPath,'--input',path.join(projectPath,'checkpoints','progress.json')]);}catch(e){cp.progress_warning=safeError(e);}
    log(progress);return progress;};
  let lock;
  const lockfile=path.join(projectPath,'checkpoints','collector.lock');
  await fs.mkdir(path.dirname(lockfile),{recursive:true});
  try{lock=await fs.open(lockfile,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString(),space_id:task.spaceId}));}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const old=await readJSON(lockfile,{});let alive=true;
    try{process.kill(old.pid,0);}catch(check){if(check.code==='ESRCH'||check.code==='ERR_INVALID_ARG_TYPE')alive=false;}
    if(alive)return {run_state:'paused',reason:'another_reader_active',completed:false};
    await fs.rename(lockfile,lockfile+'.stale-'+now());
    lock=await fs.open(lockfile,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,space_id:task.spaceId}));
  }
  let detailPage=null,pagesThisRun=0;
  const page=task.page('p1');
  async function gate(){
    if(options.signal?.aborted)throw new Stop('paused','aborted');
    if(task.ownership==='user')throw new Stop('paused','user_took_control');
    const external=await readJSON(path.join(projectPath,'control.json'),{});
    if(external.pause||external.stop)throw new Stop('paused','user_pause');
    if(options.shouldStop&&await options.shouldStop())throw new Stop('paused','user_pause');
    // The local web UI writes the backend progress record; honour it without LLM polling.
    const state=await subprocess([path.join(SCRIPT_DIR,'journal.py'),'status','--project',projectPath]);
    if(state?.progress?.paused)throw new Stop('paused','user_pause');
  }
  async function waitBudget(extra=0){
    const until=Math.max(cp.last_navigation_at+navigationIntervalMs,now()+extra);
    while(now()<until){await gate();await sleep(Math.min(1000,until-now()));}
    await gate();cp.last_navigation_at=now();await atomic(checkpointFile,cp);
  }
  async function navigate(target,url){await waitBudget();await target.goto(url);}
  async function saveCapture(snapshot,label){
    const source={...snapshot};delete source.account_hint;
    const bytes=Buffer.from(JSON.stringify(source,null,2)+'\n'),digest=sha(bytes);
    const file=path.join(projectPath,'raw','dom',label+'-'+digest+'.json');await immutable(file,bytes);
    return file;
  }
  async function ingest(file){return subprocess([path.join(SCRIPT_DIR,'ingest_exports.py'),'--project',projectPath,'--file',file]);}
  async function snapshot(number){await gate();return capturePage(page,number);}
  function checkPage(data){if(data.state==='awaiting_user_login')throw new Stop('awaiting_user_login','login_required');if(data.state==='blocked')throw new Stop('blocked',data.stop_reason||'platform_verification');}
  async function accountCheck(data){
    if(!data.account_hint)throw new Stop('blocked','account_identity_unavailable');
    const fingerprint=sha(String(data.account_hint).trim());
    if(cp.account_fingerprint&&cp.account_fingerprint!==fingerprint)throw new Stop('account_changed','visible_account_changed_use_new_project');
    cp.account_fingerprint=fingerprint;
  }
  async function cacheImages(data){
    if(options.cacheImages===false)return;
    const manifestFile=path.join(projectPath,'checkpoints','images.json'),manifest=await readJSON(manifestFile,{});
    let cached=0;
    // Prioritize one cover per observed page and valuable candidates. Missing is queued.
    const candidates=data.orders.flatMap(o=>(o.items||[]).map(i=>({o,i}))).filter(({i},n)=>i.image_url&&(n<3||i.unit_paid>=300));
    for(const {i} of candidates.slice(0,options.imagesPerPage??6)){
      await gate();let url;
      try{url=new URL(i.image_url.startsWith('//')?'https:'+i.image_url:i.image_url);}catch{continue;}
      if(url.protocol!=='https:'||!/(^|\.)alicdn\.com$/.test(url.hostname)){manifest[i.image_url]={status:'pending',reason:'observed_url_not_supported_cdn'};continue;}
      if(manifest[url.href]?.status==='cached'){i.image_file=manifest[url.href].file;continue;}
      // Public exact displayed URL, no account headers or cookies. Redirects are not followed.
      try{
        const response=await (options.fetch??fetch)(url.href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15_000)});
        if(!response.ok)throw Error('image_http_'+response.status);
        const size=Number(response.headers.get('content-length'));if(size>8*1024*1024)throw Error('image_too_large');
        const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>8*1024*1024||bytes.length<80)throw Error('image_size');
        let ext=bytes[0]===255&&bytes[1]===216?'.jpg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'.png':bytes.subarray(0,3).toString()==='GIF'?'.gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'.webp':null;
        if(!ext)throw Error('unsupported_image_body');
        const name=sha(bytes)+ext;await immutable(path.join(projectPath,'images',name),bytes);i.image_file=name;manifest[url.href]={status:'cached',file:name,sha256:sha(bytes),source:'observed_exact_public_image_url'};cached++;
      }catch(e){manifest[url.href]={status:'pending',reason:safeError(e)};}
      if(cached)await sleep(options.imageIntervalMs??1500);
    }
    await atomic(manifestFile,manifest);
  }
  async function tryExport(data){
    if(cp.export_checked||options.preferExport===false||!data.export_button)return null;
    cp.export_checked=true;await atomic(checkpointFile,cp);
    // A no-range export dialog or an explicitly observed/configured date dialog only.
    // Arm the download first; never inspect background request endpoints.
    let downloadPromise=page.waitForEvent('download',{timeout:options.downloadTimeoutMs??30_000}).then(value=>({value}),error=>({error}));
    await waitBudget();await page.click(data.export_button.selector,{label:'查看订单导出方式'});
    let opened=await snapshot(cp.current_page||1);checkPage(opened);
    if(opened.export_dialog){
      const dialog=opened.export_dialog,mode=options.exportDialogMode;
      const cancel=dialog.buttons.find(b=>/^(取消|关闭)$/.test(b.label));
      let supported=dialog.fields.length===0;
      if(mode?.kind==='date-range'){
        const observed=dialog.fields.map(f=>f.selector);
        supported=observed.includes(mode.startSelector)&&observed.includes(mode.endSelector)&&config.range_start&&config.range_end;
        if(supported){await gate();await page.fill(mode.startSelector,config.range_start);await gate();await page.fill(mode.endSelector,config.range_end);}
      }
      const submit=dialog.buttons.find(b=>/^(开始导出|立即导出|导出订单|导出)$/.test(b.label));
      if(!supported||!submit){
        if(cancel){await gate();await page.click(cancel.selector,{label:'返回订单列表'});}
        cp.export_fallback_reason='unrecognized_visible_dialog';
        // Promise rejection is handled above and is not awaited on DOM fallback.
        return null;
      }
      await gate();await page.click(submit.selector,{label:'下载已显示范围的订单'});
    }
    const {value:download,error}=await downloadPromise;
    if(error){cp.export_fallback_reason='download_not_received';return null;}
    const suggested=String(download.suggestedFilename()).replace(/[^\p{L}\p{N}_.-]/gu,'_');
    const extension=path.extname(suggested).toLowerCase();
    if(!['.csv','.xlsx','.json'].includes(extension)){cp.export_fallback_reason='unsupported_export_type';return null;}
    const temp=path.join(projectPath,'raw','downloads','download-'+now()+extension);await download.saveAs(temp);
    const bytes=await fs.readFile(temp),digest=sha(bytes),dest=path.join(projectPath,'raw','exports',digest+extension);await immutable(dest,bytes);await fs.unlink(temp);
    const result=await ingest(dest);cp.export_source=path.relative(projectPath,dest);cp.export_result=result;
    // Export may be partial and 商品金额 may be ambiguous; keep DOM traversal active.
    return result;
  }
  try{
    if(cp.completed&&!options.recheck){return await emit();}
    cp.run_state='collecting';cp.reason=null;await emit();
    let data=await snapshot(cp.current_page||1);
    checkPage(data);
    const entrySignature=sha(data.orders.map(o=>o.order_id).join('|'));
    const entryMismatch=cp.saw_first_page&&(data.current_page&&Number(data.current_page)!==cp.current_page||cp.current_signature&&entrySignature!==cp.current_signature);
    if(!cp.saw_first_page||entryMismatch||(!data.orders.length&&!data.explicit_empty&&data.state==='ready')){
      await navigate(page,LIST_URL);cp.current_page=1;cp.current_signature=null;data=await snapshot(1);
      checkPage(data);
      if(data.current_page!=='1'&&!(data.explicit_empty&&data.all_orders_selected===true))throw new Stop('blocked','first_page_not_confirmed');
    }
    if(!cp.saw_first_page){cp.saw_first_page=true;cp.contiguous=true;}
    while(pagesThisRun<maxPages){
      checkPage(data);await accountCheck(data);await gate();
      if(data.all_orders_selected===false||data.filtered_empty)throw new Stop('blocked','filtered_list_not_full_history');
      if(data.explicit_empty){cp.completed=true;cp.run_state='complete';cp.reason='explicit_empty_list';cp.coverage_boundary='true_empty';await emit();break;}
      if(!data.orders.length)throw new Stop('blocked','unrecognized_order_list');
      if(data.orders.some(o=>!o.order_id||!o.items?.length))throw new Stop('blocked','order_dom_incomplete');
      cp.list_url=data.source_url;cp.current_page=Number(data.current_page)||cp.current_page||1;
      const signature=sha(data.orders.map(o=>o.order_id).join('|'));cp.current_signature=signature;
      const dates=data.orders.map(o=>o.date).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d||''));
      const newestFirst=dates.every((d,i)=>i===0||d<=dates[i-1]);
      if(!newestFirst)throw new Stop('blocked','list_not_newest_to_oldest');
      await tryExport(data);
      if(!cp.completed_signatures.includes(signature)){
        const listRaw=await saveCapture(data,'list-'+String(cp.current_page)),initialIngest=await ingest(listRaw);
        const normalized=initialIngest.normalized?await readJSON(initialIngest.normalized,{orders:[]}):{orders:[]};
        for(const observed of data.orders){const saved=normalized.orders.find(o=>o.order_id===observed.order_id);if(saved)for(let n=0;n<observed.items.length;n++){const matched=saved.items.find(i=>i.source_index===n);if(matched)observed.items[n].item_id=matched.item_id;}}
        const selected=data.orders.filter(o=>!o.date||(!config.range_start||o.date>=config.range_start)&&(!config.range_end||o.date<=config.range_end));
        for(let index=0;index<selected.length;index++){
          const order=selected[index];
          if((order.status&&order.items.every(i=>!pendingItem(i)&&i.qty!=null&&i.spec))||!safeOrderURL(order.detail_url)||options.readDetails===false)continue;
          await gate();
          const cachedFile=cp.detail_files?.[order.order_id];
          if(cachedFile){const detail=await readJSON(path.join(projectPath,cachedFile),null);if(detail?.state==='ready'){selected[index]=mergeDetail(order,detail);continue;}}
          if(!detailPage){const pages=await task.pages();detailPage=pages.find(p=>p.label==='p2')?task.page('p2'):await task.newPage();}
          if(cp.detail_count&&cp.detail_count%detailsPerPause===0)await waitBudget(detailPauseMs);
          await navigate(detailPage,order.detail_url);
          try{await detailPage.waitForFunction(()=>document.querySelector('[class*="baseInfo--"],.order-item')||/login\./.test(location.hostname)||/操作频繁|验证码|滑动验证|接口超时/.test(document.body?.innerText||''),undefined,{timeout:15000});}
          catch(e){cp.exceptions=(cp.exceptions||[]).concat([{order_id:order.order_id,reason:'detail_timeout'}]).slice(-200);continue;}
          const detail=await captureDetail(detailPage,order.order_id);checkPage(detail);
          const detailFile=await saveCapture(detail,'detail-'+order.order_id);cp.detail_files={...cp.detail_files,[order.order_id]:path.relative(projectPath,detailFile)};selected[index]=mergeDetail(order,detail);cp.detail_count++;
          cp.detail_cursor={page_signature:signature,order_id:order.order_id};await atomic(checkpointFile,cp);
        }
        const batch={...data,orders:selected};await cacheImages(batch);
        const raw=await saveCapture(batch,'batch-'+cp.current_page),result=await ingest(raw);
        cp.captured_orders+=result.orders||0;cp.captured_items+=result.items||0;cp.pending_count+=result.pending_items||0;cp.quality_issue_count=(cp.quality_issue_count||0)+(result.quality_issues||0);
        cp.completed_signatures.push(signature);cp.last_order_id=data.orders.at(-1).order_id;cp.oldest_observed_date=dates.at(-1)||cp.oldest_observed_date;
        pagesThisRun++;await emit();
      }
      const boundary=config.range_start&&dates.length===data.orders.length&&dates.at(-1)<config.range_start;
      if(boundary||data.next_disabled){cp.completed=true;cp.run_state='complete';cp.reason=boundary?'start_date_reached':'true_last_page';cp.coverage_boundary=cp.reason;await emit();break;}
      if(pagesThisRun>=maxPages){cp.run_state='collecting';cp.reason='chunk_yield';await emit();break;}
      if(!data.next_selector)throw new Stop('blocked','next_control_unobserved');
      await waitBudget();await page.click(data.next_selector,{label:'按时间查看更早的订单'});
      try{await page.waitForFunction(old=>{const nodes=[...document.querySelectorAll('.trade-container-shopOrderContainer,#J_OrderList .js-order-container')];return nodes.length&&nodes.map(n=>(n.innerText.match(/订单号\s*[:：]\s*(\d+)/)||[])[1]).join('|')!==old;},data.orders.map(o=>o.order_id).join('|'),{timeout:15000});}
      catch(e){throw new Stop('blocked','pagination_timeout');}
      const nextData=await snapshot(cp.current_page+1);checkPage(nextData);
      if(nextData.current_page&&Number(nextData.current_page)!==cp.current_page+1){cp.contiguous=false;throw new Stop('blocked','pagination_skipped_page');}
      const nextDates=nextData.orders.map(o=>o.date).filter(Boolean);
      if(dates.length&&nextDates.some(d=>d>dates.at(-1))){cp.contiguous=false;throw new Stop('blocked','pagination_not_chronological');}
      if(sha(nextData.orders.map(o=>o.order_id).join('|'))===signature)throw new Stop('blocked','pagination_did_not_advance');
      cp.current_page++;data=nextData;
    }
    // Boundaries close the traversal, not the missing-price queue. Never claim full paid coverage.
    if(cp.completed){
      await subprocess([path.join(SCRIPT_DIR,'ingest_exports.py'),'--project',projectPath,'--finalize-coverage']);
      cp.pending_quality_count=cp.quality_issue_count||0;
      if(cp.pending_count||cp.quality_issue_count){cp.run_state='complete_with_pending';await emit();}
    }
    return {run_state:cp.run_state,completed:cp.completed,reason:cp.reason,pages_this_run:pagesThisRun,captured_orders:cp.captured_orders,pending_count:cp.pending_count,pending_quality_count:cp.quality_issue_count||0,checkpoint:checkpointFile};
  }catch(error){
    cp.completed=false;cp.run_state=error instanceof Stop?error.state:/EGO.*(?:CONTROL|OWNERSHIP|INACTIVE|UNASSIGNED)/i.test(String(error.code||''))?'paused':'blocked';cp.reason=error instanceof Stop?error.message:safeError(error);
    await emit();return {run_state:cp.run_state,completed:false,reason:cp.reason,checkpoint:checkpointFile};
  }finally{if(detailPage&&task.ownership!=='user'){try{await detailPage.close();}catch{}}if(lock){await lock.close();await fs.unlink(lockfile).catch(()=>{});}}
}
