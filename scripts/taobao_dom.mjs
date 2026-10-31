/* Visible DOM adapter only. No hidden APIs, cookies, storage or account fields. */
export async function capturePage(page, number = 1) {
  return page.evaluate(({ number }) => {
    const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const phone=/(?<!\d)(?:(?:\+?86|0086)[ \t-]?)?1[3-9](?:[ \t-]?\d){9}(?!\d)/g;
    const safe=value=>String(value||'').replace(phone,'[手机号已脱敏]').trim();
    const text=el=>visible(el)?safe(el.innerText):'';
    const css=el=>{if(!el)return null;const p=[];for(let e=el;e&&e!==document.body;e=e.parentElement){if(e.id){p.unshift('#'+CSS.escape(e.id));break;}const tag=e.tagName.toLowerCase();const siblings=e.parentElement?[...e.parentElement.children].filter(x=>x.tagName===e.tagName):[];p.unshift(tag+':nth-of-type('+(siblings.indexOf(e)+1)+')');}return 'loc=css:'+p.join(' > ');};
    const all=selector=>[...document.querySelectorAll(selector)].filter(visible);
    const controls=all('button,a,[role="button"],li.ant-pagination-next').map(e=>({label:text(e),selector:css(e),disabled:e.getAttribute('aria-disabled')==='true'||e.hasAttribute('disabled')||e.classList.contains('ant-pagination-disabled')}));
    const roots=all('.trade-container-shopOrderContainer, #J_OrderList .js-order-container');
    const body=document.body?.innerText||''; // transient for stop detection; never returned
    const login=/login\.(taobao|tmall)\.com$/.test(location.hostname)||(!roots.length&&/扫码登录|密码登录|短信登录/.test(body));
    const block=['操作频繁','访问受限','访问限制','请求过于频繁','请稍后再试','请输入验证码','请完成验证','滑动验证','拖动滑块','网络竟然崩溃了','接口超时'].find(s=>body.includes(s));
    const canonical=href=>{try{const u=new URL(href,location.href);if(!/(^|\.)(taobao|tmall)\.com$/.test(u.hostname))return null;const id=u.searchParams.get('id');return id?'https://item.taobao.com/item.htm?id='+encodeURIComponent(id)+(u.searchParams.get('skuId')?'&skuId='+encodeURIComponent(u.searchParams.get('skuId')):''):null;}catch{return null;}};
    const picture=el=>{const img=[...el.querySelectorAll('img')].find(visible);if(img)return img.currentSrc||img.src;const bg=[...el.querySelectorAll('[style*="background-image"]')].find(visible);const m=bg&&getComputedStyle(bg).backgroundImage.match(/url\(["']?(.*?)["']?\)/);return m?(m[1].startsWith('//')?'https:'+m[1]:m[1]):null;};
    const known=['交易成功','交易关闭','卖家已发货','买家已付款','等待买家付款','等待卖家发货','已退款','退款成功','退款完成','充值成功','已签收，待确认收货'];
    const getItem=el=>{
      const links=[...el.querySelectorAll('a[href]')].filter(visible).filter(a=>canonical(a.href)).map(a=>({text:text(a),href:canonical(a.href)}));
      const title=links.find(a=>a.text)?.text||text(el.querySelector('[class*="titleContainer"],[class*="title--"],.baobei-name'));
      const specNodes=[...el.querySelectorAll('[class*="info--"],.props,.item-props')].filter(visible);
      const qtyText=text(el.querySelector('[class*="quantity--"],.quantity'));
      const qtyMatch=qtyText.match(/^\s*(?:[x×]\s*)?([1-9]\d*)\s*$/);
      const source=text(el);
      const paidLines=source.split('\n').map(s=>s.trim()).filter(s=>/^(?:单件实付|单价实付|实付价|商品实付)/.test(s));
      return {name:safe(title.replace(/\s*\[交易快照\]/g,'')),spec:specNodes.map(text).filter(Boolean).join('；'),qty:qtyMatch?Number(qtyMatch[1]):null,quantity_text:qtyText,
        paid_text:paidLines.join('\n'),prices:[...el.querySelectorAll('.trade-price-container,.price')].filter(visible).map(p=>({text:text(p),struck:p.classList.contains('trade-price-container-underline')||getComputedStyle(p).textDecorationLine.includes('line-through')})),
        links,image_url:picture(el),source_text:source};
    };
    const orders=roots.map(root=>{
      const source=text(root),lines=source.split('\n').map(x=>x.trim()).filter(Boolean);
      const header=text(root.querySelector('.trade-bought-list-shop-info,.order-info'));
      let rows=[...root.querySelectorAll('.trade-bought-list-order-info,.item-list .item')].filter(visible);
      // The old and new list adapters intentionally require known product regions.
      return {order_id:(source.match(/订单号\s*[:：]\s*(\d+)/)||[])[1]||root.getAttribute('data-order-id')||null,
        date:(source.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/)||[])[0]||null,
        shop:text(root.querySelector('.trade-bought-list-shop-name,.shopname'))||lines[2]||'',
        status:known.find(s=>lines.includes(s))||null,header_text:header,
        detail_url:[...root.querySelectorAll('a[href]')].filter(visible).find(a=>/^订单详情$/.test(text(a)))?.href||null,
        payment_text:text(root.querySelector('.trade-container-orderPaymentCol,.amount')),
        items:rows.map(getItem)};
    });
    const next=all('.ant-pagination-next,.pagination-next,.next-pagination-item.next-next').at(-1);
    const dialog=all('[role="dialog"],.ant-modal,.next-dialog').at(-1);
    const exportButton=controls.find(c=>/^导出订单$/.test(c.label));
    const selectedTabs=all('[role="tab"],[class*="tab"]').filter(e=>/^(所有订单|全部订单|待付款|待发货|待收货|待评价|退款中)$/.test(text(e))&&(e.getAttribute('aria-selected')==='true'||/active|selected|current/.test(e.className)));
    const allOrdersSelected=selectedTabs.length?selectedTabs.some(e=>/^(所有订单|全部订单)$/.test(text(e))):null;
    return {capture_type:'visible_order_list',page:number,captured_at:new Date().toISOString(),source_url:location.href,
      state:login?'awaiting_user_login':block?'blocked':'ready',stop_reason:block||null,
      account_hint:text(document.querySelector('.site-nav-login-info-nick,.site-nav-user .site-nav-user-name'))||null,orders,next_selector:next?css(next):null,next_disabled:next?next.classList.contains('ant-pagination-disabled')||next.classList.contains('disabled')||next.getAttribute('aria-disabled')==='true'||next.hasAttribute('disabled'):false,
      current_page:text(document.querySelector('.ant-pagination-item-active,.pagination-current'))||null,
      all_orders_selected:allOrdersSelected,filtered_empty:!orders.length&&/没有符合条件的宝贝|没有相关订单/.test(body),
      explicit_empty:!orders.length&&allOrdersSelected===true&&/暂无订单|还没有订单/.test(body)&&!/没有符合条件的宝贝|没有相关订单/.test(body),
      export_button:exportButton||null,export_dialog:dialog?{text:text(dialog),buttons:[...dialog.querySelectorAll('button,a,[role="button"]')].filter(visible).map(e=>({label:text(e),selector:css(e)})),
        fields:[...dialog.querySelectorAll('input,select')].filter(visible).map(e=>({selector:css(e),type:e.type||e.tagName.toLowerCase(),placeholder:e.getAttribute('placeholder')||'',value:e.value||'',options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,label:o.text})):undefined}))}:null};
  }, { number });
}

export async function captureDetail(page, orderId) {
  return page.evaluate(({ orderId }) => {
    const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    const safe=t=>String(t||'').replace(/(?<!\d)(?:(?:\+?86|0086)[ \t-]?)?1[3-9](?:[ \t-]?\d){9}(?!\d)/g,'[手机号已脱敏]').trim();
    const txt=e=>visible(e)?safe(e.innerText):'';
    const body=document.body?.innerText||'',login=/login\.(taobao|tmall)\.com$/.test(location.hostname),block=['操作频繁','访问受限','请输入验证码','请完成验证','滑动验证','拖动滑块','接口超时'].find(t=>body.includes(t));
    const goods=[...document.querySelectorAll('[class*="baseInfo--"],.order-item')].filter(visible).map(e=>{
      const source=txt(e),a=[...e.querySelectorAll('a[href]')].filter(visible).find(x=>/item\.taobao|detail\.tmall/.test(x.href)&&txt(x));
      const name=txt(a)||txt(e.querySelector('[class*="title"],.item-title'));
      const q=txt(e.querySelector('[class*="quantity"],.quantity')),m=q.match(/^\s*(?:[x×]\s*)?([1-9]\d*)\s*$/);
      const priceLines=source.split('\n').map(t=>t.trim()).filter(t=>/^(?:单件实付|单价实付|实付价|商品实付)/.test(t));
      const single=priceLines.map(x=>x.match(/^(?:单件实付|单价实付)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/)).find(Boolean);
      const img=[...e.querySelectorAll('img')].find(visible);const bg=[...e.querySelectorAll('[style*="background-image"]')].find(visible);const im=bg&&getComputedStyle(bg).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      return {name,spec:[...e.querySelectorAll('[class*="info--"],.item-props,.props')].filter(visible).map(txt).join('；'),qty:m?Number(m[1]):null,paid_text:priceLines.join('\n'),
        unit_paid:single?Number(single[1]):null,unit_paid_verified:!!single,links:a?[{text:name,href:a.href}]:[],image_url:img?.currentSrc||img?.src||(im?im[1]:null),source_text:source};
    });
    const privateText=/地址|收件|寄件|联系人|联系电话|姓名|手机号|手机号码|账号|账户|运单|物流|快递单|身份证|证件号|银行卡|卡号|微信号|邮箱|电子邮件/;
    const payment=[...document.querySelectorAll('.trade-order-detail-settlement-info,[class*="payItem--"]')].filter(visible).map(txt).filter(t=>!privateText.test(t));
    const status=['交易成功','交易关闭','卖家已发货','买家已付款','已退款','退款成功','退款完成'].find(s=>[...document.querySelectorAll('span,h1,h2')].filter(visible).some(e=>txt(e)===s));
    return {capture_type:'visible_order_detail',order_id:orderId,source_url:location.href,captured_at:new Date().toISOString(),state:login?'awaiting_user_login':block?'blocked':'ready',stop_reason:block||null,status,goods,payment_text:payment.join('\n')};
  }, { orderId });
}

// Match only an unambiguous product; otherwise queue the detail instead of guessing.
export function mergeDetail(order, detail) {
  if (detail.state !== 'ready') return order;
  const normalized=t=>String(t||'').replace(/\s+/g,' ').trim().toLowerCase();
  const goods=detail.goods||[],used=new Set();
  const merged=(order.items||[]).map(item=>{
    let matches=goods.map((g,i)=>({g,i})).filter(x=>!used.has(x.i)&&normalized(x.g.name)===normalized(item.name)&&(!x.g.spec||!item.spec||normalized(x.g.spec)===normalized(item.spec)));
    if(matches.length!==1)return item;
    const {g,i}=matches[0];used.add(i);
    return {...item,...(g.paid_text?{paid_text:g.paid_text}:{}),...(g.unit_paid_verified?{unit_paid:g.unit_paid,unit_paid_verified:true}:{}),image_url:item.image_url||g.image_url,qty:item.qty??g.qty,spec:item.spec||g.spec};
  });
  return {...order,status:detail.status||order.status,payment_text:detail.payment_text||order.payment_text,items:merged};
}
