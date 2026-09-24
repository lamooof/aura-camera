/* ISOLATED-world camera processing. The shared canvas is the outgoing track source.
 * ML libraries are loaded only after a camera request, into this isolated world.
 */
(() => {
  'use strict';
  if(globalThis.__auraEngineV2)return;globalThis.__auraEngineV2=true;
  const C=globalThis.AuraCore,B=globalThis.AuraBuild,TAG='aura-camera/v2';
  const send=(type,extra={})=>window.postMessage({tag:TAG,from:'engine',type,...extra},'*');
  const sessions=new Map(),libraries=new Map();
  let settings=C.normalize(),configured=false,hookReady=false,allowed=false,revision=0,configGeneration=0;
  let image=null,imageKey='',imagePending=false,imageError='',policy={topURL:'',frameURL:location.href};
  let lastStatusAt=0;
  const average=(old,value)=>old?old*.8+value*.2:value;
  const safe=e=>String(e?.message||e).slice(0,900);
  const createCanvas=(w=1,h=1)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  async function loadLibrary(name){
    if(name==='mp'&&globalThis.AuraVision&&globalThis.AuraWasmFactory)return;
    if(name==='ort'&&globalThis.ort)return;
    if(!libraries.has(name)){
      const files={mp:['vendor/wasm-loader.js','vendor/vision.bundle.js'],ort:['vendor/ort.all.min.js']}[name];
      if(!files)throw new Error('Неизвестная библиотека');
      const promise=(async()=>{
        if(location.protocol==='chrome-extension:'){
          for(const file of files)await new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src=chrome.runtime.getURL(file);
            script.onload=resolve;script.onerror=()=>reject(new Error('Нет '+file+'. Выполните prepare.py.'));
            (document.head||document.documentElement).appendChild(script);
          });
        }else{
          const result=await chrome.runtime.sendMessage({type:'aura-load-library',library:name});
          if(!result?.ok)throw new Error(result?.error||'Не удалось загрузить библиотеку');
        }
      })().catch(e=>{libraries.delete(name);throw e;});
      libraries.set(name,promise);
    }
    return libraries.get(name);
  }
  const environment={loadLibrary,asset:path=>chrome.runtime.getURL(path)};
  function snapshot(){
    const all=[...sessions.values()],s=all[0];
    return {version:C.VERSION,hookReady,enabled:settings.enabled,siteAllowed:allowed,processingEnabled:settings.enabled&&allowed,
      algorithm:settings.algorithm,active:all.length,loading:all.some(x=>x.loading),
      processing:all.some(x=>x.processed>0&&!x.error),frames:all.reduce((n,x)=>n+x.processed,0),fps:Math.round(all.reduce((n,x)=>n+x.fps,0)),
      width:s?.canvas.width||0,height:s?.canvas.height||0,maskWidth:s?.maskWidth||0,maskHeight:s?.maskHeight||0,
      modelMs:Math.round(s?.modelMs||0),refineMs:Math.round(s?.refineMs||0),backend:s?.provider?.backend||'',
      modelAvgMs:Math.round(s?.modelAvgMs||0),refineAvgMs:Math.round(s?.refineAvgMs||0),
      composeMs:Math.round(s?.composeMs||0),readbackMs:Math.round(s?.readbackMs||0),
      refinerBackend:s?.refiner?.backend||'JavaScript',refinerWarning:s?.refinerWarning||'',
      workWidth:s?.work.width||0,workHeight:s?.work.height||0,guideWidth:s?.guide.width||0,guideHeight:s?.guide.height||0,
      skippedFrames:s?.skippedFrames||0,processingMode:settings.processing,antiflicker:settings.antiflicker,temporal:settings.temporal,
      performanceHint:s?.processed>=6 && (s.modelAvgMs+s.refineAvgMs)>90 ? 'Обработка дольше 90 мс/кадр. Попробуйте кнопку «Ускорить».':'' ,
      warning:s?.provider?.warning||'',depthInfo:s?.depthInfo||null,
      error:imageError||all.map(x=>x.error).find(Boolean)||'',hidden:document.hidden,meet:C.isMeet(policy.topURL)||C.isMeet(policy.frameURL)};
  }
  function report(force=false){
    if(!force&&performance.now()-lastStatusAt<1800)return;lastStatusAt=performance.now();
    try{chrome.runtime.sendMessage({type:'aura-engine-status',status:snapshot()}).catch(()=>{});}catch{/* Extension was reloaded. */}
  }
  function output(s){s.host.setAttribute('data-aura-last-frame',String(performance.now()));send('rendered',{id:s.id});}
  async function refreshSettings(){
    const generation=++configGeneration;
    try{
      const [saved,meta]=await Promise.all([chrome.storage.local.get(['settings','customImage']),
        location.protocol==='chrome-extension:'?Promise.resolve({topURL:location.href,frameURL:location.href}):chrome.runtime.sendMessage({type:'aura-policy'})]);
      if(generation!==configGeneration)return;
      const next=C.normalize(saved.settings);
      const reset=next.algorithm!==settings.algorithm||next.accelerator!==settings.accelerator||next.quality!==settings.quality||next.threshold!==settings.threshold||next.edge!==settings.edge||next.processing!==settings.processing||next.antiflicker!==settings.antiflicker||next.temporal!==settings.temporal;
      settings=next;policy={topURL:meta?.topURL||'',frameURL:meta?.frameURL||location.href};allowed=C.siteAllowed(settings,policy.topURL,policy.frameURL);
      revision++;configured=true;
      for(const s of sessions.values()){if(reset){s.refiner.reset();s.failedKey='';s.error='';s.modelAvgMs=0;s.refineAvgMs=0;s.lastCameraStamp=null;}s.depthInfo=null;}
      send('config',{settings:{...settings,processingEnabled:settings.enabled&&allowed}});
      if(!settings.enabled||!allowed||settings.mode!=='image'||sessions.size===0){imagePending=false;imageError='';report(true);return;}
      const key=settings.background==='custom'?saved.customImage:settings.background;
      if(key===imageKey&&image){imagePending=false;imageError='';report(true);return;}
      imagePending=true;imageError='';let nextImage;
      if(settings.background==='custom'){
        if(!C.validCustom(saved.customImage))throw new Error('Своя картинка отсутствует. Загрузите её заново.');
        const data=saved.customImage,raw=atob(data.slice(data.indexOf(',')+1)),bytes=new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
        nextImage=await createImageBitmap(new Blob([bytes],{type:data.slice(5,data.indexOf(';'))}));
      }else{
        const res=await fetch(environment.asset(`backgrounds/${settings.background}.jpg`));
        if(!res.ok)throw new Error('Не удалось открыть фон');nextImage=await createImageBitmap(await res.blob());
      }
      if(generation!==configGeneration){nextImage.close();return;}
      image?.close();image=nextImage;imageKey=key;imagePending=false;report(true);
    }catch(e){if(generation!==configGeneration)return;imagePending=false;imageError=safe(e);report(true);}
  }
  async function ensureProvider(s){
    const key=settings.algorithm+'/'+settings.accelerator;
    if(s.resetRequested||s.providerKey!==key){
      if(s.provider)await s.provider.close();s.provider=null;s.providerKey=key;s.failedKey='';s.refiner.reset();s.error='';s.resetRequested=false;
    }
    if(s.provider)return;
    if(s.failedKey===key)throw new Error(s.error||'Ошибка загрузки модели. Нажмите «Перезапустить».');
    if(!B?.installed?.[settings.algorithm])throw new Error(`Модель ${settings.algorithm} не подготовлена. Выполните python3 prepare.py --all и перезагрузите расширение.`);
    s.loading=true;C.slate(s.canvas,'Загрузка '+C.ALGORITHMS[settings.algorithm].name,'Первый запуск может занять несколько секунд');output(s);report(true);
    try{s.provider=await globalThis.AuraModels.create(settings.algorithm,settings,environment);}
    catch(e){s.failedKey=key;s.error=safe(e);throw e;}
    finally{s.loading=false;}
  }
  async function ensureRefiner(s){
    if(s.nativeAttempted)return;s.nativeAttempted=true;
    try{
      if(!globalThis.AuraNative)throw new Error('Обновление установлено не полностью');
      const next=await globalThis.AuraNative.create(environment.asset);
      if(s.closed){next.close();return;}
      s.refiner.close();s.refiner=next;s.refinerWarning='';
    }catch(e){s.refinerWarning='WASM-фильтр недоступен; используется JavaScript: '+safe(e);}
  }
  function cameraStamp(s){
    const total=s.video.getVideoPlaybackQuality?.().totalVideoFrames;
    return total>0?'f'+total:'t'+s.video.currentTime;
  }
  function resize(s){
    const size=C.fitSize(s.video.videoWidth,s.video.videoHeight,settings.quality);
    for(const c of [s.canvas,s.frame,s.foreground,s.background])if(c.width!==size.width||c.height!==size.height){c.width=size.width;c.height=size.height;s.refiner.reset();s.backgroundKey='';}
    const work=C.refinementSize(size.width,size.height,settings.quality,settings.processing);
    for(const c of [s.work,s.matte])if(c.width!==work.width||c.height!==work.height){c.width=work.width;c.height=work.height;s.refiner.reset();}
    const guide=C.guideSize(work.width,work.height,settings.quality,settings.processing);
    if(s.guide.width!==guide.width||s.guide.height!==guide.height){s.guide.width=guide.width;s.guide.height=guide.height;}
    if(!s.maskData||s.maskData.width!==work.width||s.maskData.height!==work.height){
      s.maskData=s.matte.getContext('2d').createImageData(work.width,work.height);
      // White RGB never changes; only alpha is filled by the JS fallback.
      s.maskData.data.fill(255);
    }
  }
  async function drawMasked(s){
    const rev=revision,opts={...settings};await ensureProvider(s);await ensureRefiner(s);
    if(s.closed||revision!==rev)return;
    const w=s.canvas.width,h=s.canvas.height,ww=s.work.width,wh=s.work.height;
    // No full-size getImageData on the snapshot canvas in efficient mode.
    const fc=s.frame.getContext('2d');s.lastCameraStamp=cameraStamp(s);fc.drawImage(s.video,0,0,w,h);
    const started=performance.now();
    opts.frameDeltaMs=s.lastRefinedCapture==null?1000/30:started-s.lastRefinedCapture;
    const mask=await s.provider.predict(s.frame,opts);s.modelMs=performance.now()-started;
    if(s.closed||revision!==rev)return;
    const refineStarted=performance.now(),wc=s.work.getContext('2d',{willReadFrequently:true});
    wc.imageSmoothingEnabled=true;wc.drawImage(s.frame,0,0,ww,wh);
    const pixels=wc.getImageData(0,0,ww,wh).data;
    const gc=s.guide.getContext('2d',{willReadFrequently:true});gc.drawImage(s.frame,0,0,s.guide.width,s.guide.height);
    const guidePixels=gc.getImageData(0,0,s.guide.width,s.guide.height).data;
    s.readbackMs=performance.now()-refineStarted;
    const alpha=s.refiner.refine(mask,pixels,ww,wh,guidePixels,s.guide.width,s.guide.height,opts);
    s.lastRefinedCapture=started;
    let maskImage=s.refiner.imageData;
    if(!maskImage){
      const data=s.maskData.data;
      for(let i=0;i<alpha.length;i++)data[i*4+3]=Math.round(alpha[i]*255);
      maskImage=s.maskData;
    }
    s.matte.getContext('2d').putImageData(maskImage,0,0);
    const composeStarted=performance.now();
    const fg=s.foreground.getContext('2d');fg.save();fg.globalCompositeOperation='copy';fg.filter='none';fg.drawImage(s.frame,0,0);
    fg.globalCompositeOperation='destination-in';fg.imageSmoothingEnabled=true;fg.imageSmoothingQuality='high';
    if(opts.feather>0)fg.filter=`blur(${opts.feather}px)`;fg.drawImage(s.matte,0,0,w,h);fg.restore();
    const ctx=s.canvas.getContext('2d');ctx.save();ctx.globalCompositeOperation='copy';ctx.filter='none';
    if(opts.mode==='image'){
      if(s.backgroundImage!==image||s.backgroundKey!==imageKey){
        const bc=s.background.getContext('2d');bc.globalCompositeOperation='copy';C.drawCover(bc,image,w,h);s.backgroundImage=image;s.backgroundKey=imageKey;
      }
      ctx.drawImage(s.background,0,0);
    }else{ctx.fillStyle=opts.color;ctx.fillRect(0,0,w,h);}
    ctx.globalCompositeOperation='source-over';
    if(opts.mode==='blur'){const bleed=opts.blur*2;ctx.filter=`blur(${opts.blur}px)`;ctx.drawImage(s.frame,-bleed,-bleed,w+2*bleed,h+2*bleed);ctx.filter='none';}
    ctx.drawImage(s.foreground,0,0);ctx.restore();
    s.composeMs=performance.now()-composeStarted;s.refineMs=performance.now()-refineStarted;
    s.modelAvgMs=average(s.modelAvgMs,s.modelMs);s.refineAvgMs=average(s.refineAvgMs,s.refineMs);
    s.maskWidth=mask.width;s.maskHeight=mask.height;s.depthInfo=mask.depthInfo||null;
    s.processed++;s.frameCount++;s.error='';
    const elapsed=performance.now()-s.rateStart;if(elapsed>=1000){s.fps=s.frameCount*1000/elapsed;s.frameCount=0;s.rateStart=performance.now();}
  }
  async function cleanup(s){
    if(s.cleaned)return;s.cleaned=true;
    try{await s.provider?.close();}catch{/* Context lost while closing. */}
    s.provider=null;s.refiner.close();s.maskData=null;
    for(const c of [s.frame,s.foreground,s.matte,s.guide,s.work,s.background])c.width=c.height=1;
  }
  async function tick(s){
    if(s.closed)return;s.busy=true;const started=performance.now();
    try{
      if(!s.host.isConnected||!s.video.srcObject){stop(s.id);return;}
      const track=s.video.srcObject.getVideoTracks()[0];
      if(!track||track.readyState==='ended'){stop(s.id);return;}
      if(!track.enabled||track.muted){C.slate(s.canvas,'Камера выключена');s.fps=0;s.refiner.reset();}
      else if(s.video.readyState<2||!s.video.videoWidth)C.slate(s.canvas,'Ожидание камеры…');
      else{
        resize(s);
        if(!settings.enabled||!allowed){
          // A user explicitly disabled the effect. Existing canvas tracks show raw camera.
          const ctx=s.canvas.getContext('2d');ctx.globalCompositeOperation='source-over';ctx.filter='none';ctx.drawImage(s.video,0,0,s.canvas.width,s.canvas.height);
          s.error='';s.fps=0;s.refiner.reset();
          if(s.provider){await s.provider.close();s.provider=null;}
        }else if(imageError)throw new Error(imageError);
        else if(settings.mode==='image'&&(imagePending||!image))C.slate(s.canvas,'Загрузка фона…');
        else if(s.lastCameraStamp!==null && s.lastCameraStamp===cameraStamp(s) && !s.resetRequested){s.skippedFrames++;return;}
        else await drawMasked(s);
      }
      if(!s.closed)output(s);
    }catch(e){
      s.error=safe(e);s.fps=0;s.refiner.reset();
      if(!s.closed){C.slate(s.canvas,'Обработка остановлена','Aura Camera → Диагностика');output(s);report(true);}
    }finally{
      s.busy=false;report();
      if(s.closed)await cleanup(s);
      else s.timer=setTimeout(()=>tick(s),Math.max(s.error?500:4,1000/C.PROFILES[settings.quality].fps-(performance.now()-started)));
    }
  }
  function start(id){
    if(typeof id!=='string'||!/^aura-pipe-[a-f0-9-]+$/.test(id)||sessions.has(id))return;
    const host=document.getElementById(id);if(!host||host.getAttribute('data-aura-pipeline')!=='1')return;
    const video=host.querySelector('video'),canvas=host.querySelector('canvas');
    if(!(video instanceof HTMLVideoElement)||!(canvas instanceof HTMLCanvasElement)||!video.srcObject)return;
    const s={id,host,video,canvas,frame:createCanvas(),foreground:createCanvas(),matte:createCanvas(),guide:createCanvas(),work:createCanvas(),background:createCanvas(),
      backgroundKey:'',backgroundImage:null,nativeAttempted:false,refinerWarning:'',lastCameraStamp:null,skippedFrames:0,modelAvgMs:0,refineAvgMs:0,
      refiner:new C.RGBRefiner(),provider:null,providerKey:'',failedKey:'',error:'',processed:0,fps:0,frameCount:0,rateStart:performance.now(),busy:false,closed:false};
    sessions.set(id,s);refreshSettings();tick(s);report(true);
  }
  function stop(id){
    const s=sessions.get(id);if(!s)return;s.closed=true;clearTimeout(s.timer);sessions.delete(id);
    if(!s.busy)cleanup(s);
    if(!sessions.size){configGeneration++;image?.close();image=null;imageKey='';imagePending=false;imageError='';}
    report(true);
  }
  function retry(){revision++;for(const s of sessions.values()){s.resetRequested=true;s.failedKey='';s.error='';s.refiner.reset();s.lastCameraStamp=null;}refreshSettings();}
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==window||!m||m.tag!==TAG||m.from!=='main')return;
    if(m.type==='hello'&&configured)send('config',{settings:{...settings,processingEnabled:settings.enabled&&allowed}});
    else if(m.type==='hook-ready'){hookReady=true;report(true);}
    else if(m.type==='start')start(m.id);else if(m.type==='stop')stop(m.id);
  });
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.settings||changes.customImage))refreshSettings();});
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(m?.type==='aura-ping'){report(true);respond(snapshot());}
    else if(m?.type==='aura-retry'){retry();respond({ok:true});}
  });
  if(location.protocol==='chrome-extension:')globalThis.AuraPreviewEngine={snapshot,retry,createTestModel:(kind,opts)=>globalThis.AuraModels.create(kind,opts,environment)};
  window.addEventListener('pagehide',()=>{for(const id of [...sessions.keys()])stop(id);image?.close();image=null;imageKey='';});
  window.addEventListener('pageshow',e=>{if(e.persisted)refreshSettings();});
  refreshSettings();send('probe');
})();
