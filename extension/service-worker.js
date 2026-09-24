'use strict';
importScripts('core.js');
const states=new Map(),loads=new Map();
const LIBRARIES={mp:['vendor/wasm-loader.js','vendor/vision.bundle.js'],ort:['vendor/ort.all.min.js']};
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(m?.type==='aura-policy'){
    // Use Chrome's sender metadata, not a top-level URL supplied by a page.
    respond({topURL:sender.tab?.url||'',frameURL:sender.url||''});return;
  }
  if(m?.type==='aura-load-library'){
    if(!sender.tab||typeof m.library!=='string'||!Object.hasOwn(LIBRARIES,m.library)){respond({ok:false,error:'Недопустимый запрос библиотеки'});return;}
    const key=`${sender.tab.id}/${sender.documentId||sender.frameId}/${m.library}`;
    if(!loads.has(key)){
      const target=sender.documentId?{tabId:sender.tab.id,documentIds:[sender.documentId]}:{tabId:sender.tab.id,frameIds:[sender.frameId||0]};
      loads.set(key,chrome.scripting.executeScript({target,files:LIBRARIES[m.library],world:'ISOLATED'}));
    }
    loads.get(key).then(()=>respond({ok:true}),e=>{loads.delete(key);respond({ok:false,error:String(e.message||e)});});return true;
  }
  if(m?.type==='aura-engine-status'&&sender.tab&&m.status){
    const tab=states.get(sender.tab.id)||new Map();
    tab.set(sender.frameId||0,{...m.status,at:Date.now()});states.set(sender.tab.id,tab);
    const all=[...tab.values()].filter(s=>Date.now()-s.at<10000);
    const err=all.some(s=>s.error),active=all.some(s=>s.active>0&&s.processingEnabled);
    chrome.action.setBadgeText({tabId:sender.tab.id,text:err?'!':active?'ON':''}).catch(()=>{});
    chrome.action.setBadgeBackgroundColor({tabId:sender.tab.id,color:err?'#a54042':'#236c5d'}).catch(()=>{});
    respond({ok:true});return;
  }
  if(m?.type==='aura-query'&&Number.isInteger(m.tabId)){
    (async()=>{
      try{await chrome.tabs.sendMessage(m.tabId,{type:'aura-ping'});}catch{/* Restricted/internal page or not reloaded. */}
      const all=[...(states.get(m.tabId)?.values()||[])].filter(s=>Date.now()-s.at<10000);
      const current=all.find(s=>s.active>0)||all.find(s=>s.hookReady)||all[0];
      respond(current||{hookReady:false,active:0,error:'',missing:true});
    })();return true;
  }
});
chrome.tabs.onRemoved.addListener(id=>{
  states.delete(id);for(const key of loads.keys())if(key.startsWith(id+'/'))loads.delete(key);
});
chrome.tabs.onUpdated.addListener((id,info)=>{
  if(info.status==='loading'){
    states.delete(id);for(const key of loads.keys())if(key.startsWith(id+'/'))loads.delete(key);
  }
});
