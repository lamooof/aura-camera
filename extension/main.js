/* Runs in the page MAIN world, before the meeting application captures getUserMedia.
 * No ML, storage, external code, or site UI manipulation in this world.
 * A shared DOM canvas is the *source* of the returned video track, not an overlay.
 */
(() => {
  'use strict';
  if (!navigator.mediaDevices || typeof MediaStreamTrack==='undefined') return;
  const KEY=Symbol.for('aura-camera.main.v2');
  if(globalThis[KEY]) return;
  Object.defineProperty(globalThis,KEY,{value:true});
  const TAG='aura-camera/v2';
  const send=(type,extra={})=>window.postMessage({tag:TAG,from:'main',type,...extra},'*');
  const trackOwner=new WeakMap(), sessions=new Set();
  const tp=MediaStreamTrack.prototype, sp=MediaStream.prototype;
  const nativeStop=tp.stop, nativeClone=tp.clone, nativeStreamClone=sp.clone;
  const enabledDescriptor=Object.getOwnPropertyDescriptor(tp,'enabled');
  const media=navigator.mediaDevices;
  const nativeGUM=media.getUserMedia;
  let ready=false,settings={quality:'high',processingEnabled:true},resolveReady;
  const readyPromise=new Promise(resolve=>{resolveReady=resolve;});

  function initialSlate(canvas,title='Подготовка фона…') {
    const ctx=canvas.getContext('2d');
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.filter='none';
    ctx.fillStyle='#15202c';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#e3eaf1';ctx.font='22px sans-serif';ctx.textAlign='center';
    ctx.fillText(title,canvas.width/2,canvas.height/2,canvas.width*0.9);ctx.restore();
  }
  function dispose(session,ended=false) {
    if(session.closed) return;
    session.closed=true;clearInterval(session.monitor);
    for(const track of session.tracks){
      if(track.readyState!=='ended') {nativeStop.call(track);if(ended)track.dispatchEvent(new Event('ended'));}
    }
    nativeStop.call(session.rawTrack); session.video.pause();session.video.srcObject=null;
    sessions.delete(session);send('stop',{id:session.node.id});session.node.remove();
  }
  function reconcile(session) {
    if(session.closed) return;
    const active=[...session.tracks].filter(t=>t.readyState==='live');
    if(!active.length) {dispose(session);return;}
    session.rawTrack.enabled=active.some(t=>t.enabled);
  }
  function register(track,session) {
    trackOwner.set(track,session);session.tracks.add(track);
    // These methods describe the physical camera plus the actual outgoing canvas dimensions.
    const originalSettings=track.getSettings.bind(track);
    Object.defineProperties(track,{
      getSettings:{configurable:true,value:()=>({ ...session.rawTrack.getSettings(), ...originalSettings(),
        deviceId:session.rawTrack.getSettings().deviceId,groupId:session.rawTrack.getSettings().groupId,
        width:session.canvas.width,height:session.canvas.height,aspectRatio:session.canvas.width/session.canvas.height })},
      getConstraints:{configurable:true,value:()=>session.rawTrack.getConstraints()},
      getCapabilities:{configurable:true,value:()=>session.rawTrack.getCapabilities?.() || {}},
      applyConstraints:{configurable:true,value:async constraints=>{
        if(session.closed) throw new DOMException('Камера уже остановлена','InvalidStateError');
        await session.rawTrack.applyConstraints(constraints);
      }}
    });
    if(enabledDescriptor?.get && enabledDescriptor?.set) {
      Object.defineProperty(track,'enabled',{configurable:true,
        get(){return enabledDescriptor.get.call(this);},
        set(v){enabledDescriptor.set.call(this,v);reconcile(session);}
      });
    }
    track.addEventListener('ended',()=>reconcile(session));
    return track;
  }
  tp.stop=function(){ const result=nativeStop.call(this);const owner=trackOwner.get(this);if(owner)reconcile(owner);return result;};
  tp.clone=function(){ const cloned=nativeClone.call(this),owner=trackOwner.get(this);return owner?register(cloned,owner):cloned;};
  sp.clone=function(){
    // Native MediaStream.clone() otherwise bypasses the JavaScript track.clone wrapper.
    return this.getTracks().some(t=>trackOwner.has(t)) ? new MediaStream(this.getTracks().map(t=>t.clone())) : nativeStreamClone.call(this);
  };
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==window || !m || m.tag!==TAG || m.from!=='engine')return;
    if(m.type==='config'){
      if(m.settings && typeof m.settings.quality==='string') settings=m.settings;
      ready=true;resolveReady();send('hook-ready');
    } else if(m.type==='probe')send('hook-ready');
    else if(m.type==='rendered' && typeof m.id==='string') {
      for(const s of sessions)if(s.node.id===m.id){s.lastRender=performance.now();s.track.requestFrame?.();break;}
    }
  });
  async function interceptedGetUserMedia(constraints) {
    const v=constraints?.video;
    const screen=v && typeof v==='object' && (v.mandatory?.chromeMediaSource || v.chromeMediaSource);
    if(!v || screen)return nativeGUM.call(this,constraints);
    if(!ready){
      send('hello');
      let timeout;
      try {
        await Promise.race([readyPromise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new DOMException(
          'Aura Camera не ответила. Перезагрузите вкладку или отключите расширение на этом сайте.','NotReadableError')),8000);})]);
      }finally{clearTimeout(timeout);}
    }
    // An excluded site receives the native stream, without any canvas processing.
    if(!settings.processingEnabled)return nativeGUM.call(this,constraints);
    const raw=await nativeGUM.call(this,constraints);
    const rawTrack=raw.getVideoTracks()[0];
    if(!rawTrack)return raw;
    let session;
    try{
      const node=document.createElement('div');node.id='aura-pipe-'+(crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join(''));
      node.setAttribute('data-aura-pipeline','1');node.setAttribute('aria-hidden','true');
      node.style.cssText='position:fixed!important;left:-10000px!important;top:0!important;width:2px!important;height:2px!important;overflow:hidden!important;pointer-events:none!important;';
      const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;
      const canvas=document.createElement('canvas');
      const rs=rawTrack.getSettings(),max=['ultra','high'].includes(settings.quality)?1280:settings.quality==='eco'?640:960;
      const maxH=settings.quality==='eco'?480:720;
      const scale=Math.min(1,max/(rs.width||640),maxH/(rs.height||480));
      canvas.width=Math.max(2,Math.floor((rs.width||640)*scale/2)*2);canvas.height=Math.max(2,Math.floor((rs.height||480)*scale/2)*2);
      initialSlate(canvas);
      // The video holds only the source video track; microphone tracks are passed through untouched.
      video.srcObject=new MediaStream([rawTrack]);node.append(video,canvas);
      if(!document.documentElement)await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
      document.documentElement.appendChild(node);
      const captured=canvas.captureStream(30),track=captured.getVideoTracks()[0];
      if(!track)throw new Error('Canvas captureStream не вернул видеотрек');
      session={node,video,canvas,rawTrack,track,tracks:new Set(),closed:false,lastRender:performance.now()};
      sessions.add(session);register(track,session);
      rawTrack.addEventListener('ended',()=>dispose(session,true));
      session.monitor=setInterval(()=>{
        if(!node.isConnected){dispose(session);return;}
        reconcile(session);
        if(!session.closed && performance.now()-session.lastRender>5000){
          initialSlate(canvas,'Обработка приостановлена');track.requestFrame?.();
        }
      },500);
      await video.play();
      // A first neutral frame is emitted before any website receives this stream.
      track.requestFrame?.();send('start',{id:node.id});
      return new MediaStream([track,...raw.getAudioTracks()]);
    }catch(error){
      if(session)dispose(session);
      for(const t of raw.getTracks())nativeStop.call(t);
      throw new DOMException('Aura Camera: '+(error?.message||String(error)),'NotReadableError');
    }
  }
  // Overriding the prototype also covers code that reads it rather than the instance.
  const proto=Object.getPrototypeOf(media),desc=Object.getOwnPropertyDescriptor(proto,'getUserMedia');
  if(desc?.configurable)Object.defineProperty(proto,'getUserMedia',{...desc,value:interceptedGetUserMedia});
  else Object.defineProperty(media,'getUserMedia',{configurable:true,writable:true,value:interceptedGetUserMedia});
  for(const name of ['getUserMedia','webkitGetUserMedia']) {
    if(typeof navigator[name]==='function')try{
      Object.defineProperty(navigator,name,{configurable:true,value:(c,ok,bad)=>media.getUserMedia(c).then(ok,bad)});
    }catch{/* The standard mediaDevices API is still intercepted. */}
  }
  window.addEventListener('pagehide',()=>{for(const s of [...sessions])dispose(s);});
  send('hello');
})();
