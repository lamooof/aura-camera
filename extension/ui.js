/* Settings UI. Opening the popup never opens the webcam. */
(() => {
  'use strict';
  const C=AuraCore,$=id=>document.getElementById(id),isPreview=document.body.dataset.view==='preview';
  let settings=C.normalize(),customImage='',tabId=null,stream=null,statusTimer=null,saveQueue=Promise.resolve(),saving=0;
  let latestStatus={},modelReport=null,modelTestRunning=false;
  const help={
    fast:'Лёгкая сегментация 256 × 144 + восстановление края по RGB. Подходит для сравнения со старой моделью.',
    multiclass:'Шесть классов, включая волосы, кожу, одежду и аксессуары. Используется объединение всех классов человека + RGB guided filter. Это сегментация, не специализированный маттинг.',
    rvm:'Настоящая alpha-маска и рекуррентная память между кадрами. Требует ONNX Runtime; обычно тяжелее Selfie. При переключении камеры память сбрасывается.',
    modnet:'Портретный alpha-маттинг без рекуррентной памяти RVM. Используется MODNet Webcam, ONNX-экспорт yakhyo. Нагрузка зависит от разрешения и GPU.',
    depth:'Эксперимент: SelfieMulticlass + MiDaS Small. Глубина рассчитывается нейросетью по RGB и корректирует только спорные участки. Кресло рядом с человеком может остаться.'
  };
  const notice=(text='')=>{$('notice').textContent=text;$('notice').hidden=!text;};
  function setStatus(kind,title,text){$('status').className='status '+kind;$('statusTitle').textContent=title;$('statusText').textContent=text;}
  function paint(){
    for(const key of ['enabled','everywhere','meetEnabled','antiflicker'])$(key).checked=settings[key];
    for(const key of ['quality','accelerator','processing','color'])$(key).value=settings[key];
    const algorithms=$('algorithm');algorithms.replaceChildren();
    for(const [key,value] of Object.entries(C.ALGORITHMS)){
      const option=document.createElement('option');option.value=key;option.textContent=value.name+(!AuraBuild.installed[key]?' — не скачано':'');
      option.disabled=!AuraBuild.installed[key];algorithms.appendChild(option);
    }
    algorithms.value=settings.algorithm;$('algorithmHelp').textContent=help[settings.algorithm];
    $('setupNotice').hidden=!!AuraBuild.prepared;
    for(const [key,scale,suffix] of [['blur',1,''],['threshold',100,'%'],['edge',1,''],['temporal',100,'%'],['feather',1,' px'],['depthStrength',100,'%'],['depthInterval',1,' ms']]){
      const value=Math.round(settings[key]*scale*10)/10;$(key).value=value;$(key+'Value').textContent=value+suffix;
    }
    $('depthOptions').hidden=settings.algorithm!=='depth';
    document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('selected',b.dataset.mode===settings.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===settings.mode));});
    for(const mode of ['image','blur','color'])$(mode+'Options').hidden=settings.mode!==mode;
    const gallery=$('gallery');gallery.replaceChildren();
    const options=C.BACKGROUNDS.map(b=>({...b,src:chrome.runtime.getURL(`backgrounds/${b.id}.jpg`)}));
    if(customImage)options.push({id:'custom',name:'Ваш фон',src:customImage});
    for(const bg of options){
      const button=document.createElement('button');button.className='tile'+(settings.background===bg.id?' selected':'');
      button.title=bg.name;button.setAttribute('aria-label',bg.name);button.setAttribute('aria-pressed',String(settings.background===bg.id));
      const img=document.createElement('img');img.src=bg.src;img.alt='';const label=document.createElement('span');label.textContent=bg.name;button.append(img,label);
      button.addEventListener('click',()=>update({background:bg.id,mode:'image',enabled:true}));gallery.appendChild(button);
    }
    $('removeCustom').hidden=!customImage;
  }
  async function load(){const data=await chrome.storage.local.get(['settings','customImage']);settings=C.normalize(data.settings);customImage=C.validCustom(data.customImage)?data.customImage:'';paint();}
  function update(patch){
    settings=C.normalize({...settings,...patch});paint();const value={...settings};saving++;
    saveQueue=saveQueue.catch(()=>{}).then(()=>chrome.storage.local.set({settings:value})).catch(e=>notice('Не удалось сохранить: '+e.message)).finally(()=>{saving--;});
  }
  function displayStatus(s={}){
    latestStatus=s;
    if(!settings.enabled)setStatus('warning','Эффект выключен','Сайт получает обычное изображение камеры.');
    else if(s.siteAllowed===false)setStatus('warning','Сайт исключён из обработки',s.meet?'Google Meet использует обычную камеру. Включить Aura можно переключателем выше.':'Обработка разрешена только в Телемосте.');
    else if(s.error)setStatus('error','Обработка остановлена','Вместо обработанного видео показывается заглушка. Причина указана в диагностике.');
    else if(!AuraBuild.prepared)setStatus('warning','Нужна подготовка моделей','Выполните prepare.py --all, затем перезагрузите расширение.');
    else if(!s.hookReady)setStatus('warning','Нет подключения к странице',isPreview?'Подождите и включите предпросмотр.':'Обновите страницу сайта. Внутренние страницы Chrome не поддерживаются.');
    else if(!s.active)setStatus('','Готово к запросу камеры','Камера ещё не запрошена сайтом; модели не запущены.');
    else if(s.loading||!s.processing)setStatus('','Подготовка модели…','Первый запуск может занять несколько секунд.');
    else setStatus(s.warning||s.performanceHint?'warning':'',s.performanceHint?'Не хватает скорости обработки':'Фон обрабатывается',`${s.width} × ${s.height} · ${s.fps||0} кадр/с · ${s.backend||'локально'}`);
    const d=s.depthInfo;
    $('diagnostic').textContent=[
      'Aura Camera '+C.VERSION+' · тестовая сборка',
      'Алгоритм: '+C.ALGORITHMS[settings.algorithm].name,
      'Подключение: '+(s.hookReady?'установлено':'нужна перезагрузка страницы'),
      'Активных потоков: '+(s.active||0)+' · кадров: '+(s.frames||0),
      'Видео: '+(s.width||0)+' × '+(s.height||0)+' · маска: '+(s.maskWidth||0)+' × '+(s.maskHeight||0),
      'FPS обработанных кадров: '+(s.fps||0),
      'Антимерцание: '+(settings.antiflicker?'включено, 3 маски + RGB':'выключено, алгоритм 0.4.1')+' · стабилизация '+Math.round(settings.temporal*100)+'%',
      'Модель: '+(s.modelMs||0)+' ms · RGB/композиция: '+(s.refineMs||0)+' ms',
      'Среднее: модель '+(s.modelAvgMs||0)+' ms · обработка '+(s.refineAvgMs||0)+' ms',
      'RGB-фильтр: '+(s.refinerBackend||'не запущен')+' · '+(s.workWidth||0)+' × '+(s.workHeight||0),
      'Чтение RGB: '+(s.readbackMs||0)+' ms · композиция: '+(s.composeMs||0)+' ms',
      'Режим нагрузки: '+(settings.processing==='detail'?'Полная детализация':'Для звонка'),
      s.active>1?'Внимание: сайт использует несколько потоков камеры; обработка выполняется для каждого.':'',
      s.performanceHint||'',s.refinerWarning||'',
      'Вычисления: '+(s.backend||'не запущены'),
      d?'Глубина: '+d.reason+'; карта '+d.width+' × '+d.height+'; расчёт '+d.modelMs+' ms':'',
      s.warning?'Предупреждение: '+s.warning:'',
      s.error?'Ошибка: '+s.error:'Ошибка: нет',
      'Это замеры текущего потока, не обещанный FPS.'
    ].filter(Boolean).join('\n');
  }
  async function poll(){
    try{
      if(isPreview&&globalThis.AuraPreviewEngine){displayStatus(AuraPreviewEngine.snapshot());return;}
      if(tabId)displayStatus(await chrome.runtime.sendMessage({type:'aura-query',tabId}));
      else displayStatus({missing:true});
    }catch(e){setStatus('warning','Обновите страницу','Не удалось получить состояние расширения.');}
  }
  function saveJSON(value,name){
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function upload(file){
    if(!file)return;
    notice();$('upload').disabled=true;
    try{
      if(!['image/jpeg','image/png','image/webp','image/avif'].includes(file.type))throw new Error('Нужна картинка JPG, PNG, WebP или AVIF.');
      if(file.size>20*1024*1024)throw new Error('Размер файла больше 20 МБ.');
      const bitmap=await createImageBitmap(file);
      try{
        if(bitmap.width*bitmap.height>36_000_000)throw new Error('Картинка слишком большая: максимум 36 мегапикселей.');
        const factor=Math.min(1,1600/bitmap.width,1200/bitmap.height);
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*factor));canvas.height=Math.max(1,Math.round(bitmap.height*factor));
        const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
        const data=canvas.toDataURL('image/webp',0.85);
        if(!C.validCustom(data))throw new Error('Картинка после обработки слишком большая. Используйте изображение поменьше.');
        await saveQueue;settings=C.normalize({...settings,enabled:true,mode:'image',background:'custom'});
        await chrome.storage.local.set({customImage:data,settings});customImage=data;paint();
      }finally{bitmap.close();}
    }catch(error){notice(error.message || 'Не удалось прочитать изображение.');}
    finally{$('upload').disabled=false;$('file').value='';}
  }
  for(const key of ['enabled','everywhere','meetEnabled'])$(key).addEventListener('change',e=>{
    update({[key]:e.target.checked});
    if(key!=='enabled')notice('Настройка сохранена. Выключите камеру и обновите страницу звонка, чтобы применить её ко всем потокам.');
  });
  for(const key of ['quality','algorithm','accelerator','processing','color'])$(key).addEventListener('change',e=>update({[key]:e.target.value}));
  for(const [key,scale,suffix] of [['blur',1,''],['threshold',100,'%'],['edge',1,''],['temporal',100,'%'],['feather',1,' px'],['depthStrength',100,'%'],['depthInterval',1,' ms']]){
    $(key).addEventListener('input',e=>{$(key+'Value').textContent=e.target.value+suffix;});
    $(key).addEventListener('change',e=>update({[key]:Number(e.target.value)/scale}));
  }
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>update({mode:b.dataset.mode,enabled:true})));
  $('upload').addEventListener('click',()=>$('file').click());$('file').addEventListener('change',e=>upload(e.target.files[0]));
  $('removeCustom').addEventListener('click',async()=>{
    try{await saveQueue;if(settings.background==='custom')settings=C.normalize({...settings,background:'studio'});await chrome.storage.local.set({customImage:'',settings});customImage='';paint();}catch(e){notice(e.message);}
  });
  $('speedPreset').addEventListener('click',()=>{
    if(!AuraBuild.installed.fast){notice('Быстрая модель не подготовлена. Выполните python3 prepare.py --models fast.');return;}
    update(C.speedPreset(settings));
    notice('Включён быстрый профиль: Selfie, Баланс, Для звонка, Авто. Фон и настройки сайтов сохранены. Если камера была открыта — выключите и включите её.');
  });
  $('antiflicker').addEventListener('change',e=>update({antiflicker:e.target.checked}));
  $('antiflickerPreset').addEventListener('click',()=>{
    update(C.antiflickerPreset(settings));
    notice('Антимерцание включено, стабилизация 40%. Модель, разрешение, мягкость, фон и настройки сайтов не изменены.');
  });
  $('openPreview')?.addEventListener('click',()=>chrome.runtime.openOptionsPage());
  $('retry').addEventListener('click',async()=>{
    notice();try{if(isPreview)AuraPreviewEngine.retry();else if(tabId)await chrome.tabs.sendMessage(tabId,{type:'aura-retry'});else throw new Error();setTimeout(poll,700);}
    catch{notice('Обновите страницу сайта и включите камеру.');}
  });
  $('exportDiagnostic').addEventListener('click',()=>saveJSON({version:C.VERSION,userAgent:navigator.userAgent,settings,build:AuraBuild,status:latestStatus,containsFrames:false},'aura-camera-diagnostic.json'));
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&!saving&&(changes.settings||changes.customImage))load().catch(e=>notice(e.message));});
  if(isPreview){
    $('startPreview').addEventListener('click',async()=>{
      if(modelTestRunning)return;notice();$('startPreview').disabled=true;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:25,max:30}}});
        $('cameraOutput').srcObject=stream;await $('cameraOutput').play();$('placeholder').hidden=true;$('stopPreview').disabled=false;$('testModels').disabled=true;
      }catch(e){stream?.getTracks().forEach(t=>t.stop());stream=null;$('startPreview').disabled=false;notice('Камера: '+e.message);}
    });
    $('stopPreview').addEventListener('click',()=>{
      stream?.getTracks().forEach(t=>t.stop());stream=null;$('cameraOutput').srcObject=null;$('placeholder').hidden=false;
      $('startPreview').disabled=false;$('stopPreview').disabled=true;$('testModels').disabled=false;
    });
    $('mirror').addEventListener('change',e=>{$('cameraOutput').style.transform=e.target.checked?'scaleX(-1)':'none';});$('cameraOutput').style.transform='scaleX(-1)';
    $('testModels').addEventListener('click',async()=>{
      if(stream||modelTestRunning)return;modelTestRunning=true;$('testModels').disabled=true;$('startPreview').disabled=true;$('saveModelReport').disabled=true;
      try{
        modelReport=await AuraSelfTest.run(name=>{$('modelReport').textContent=name?'Проверяется '+name+'…':'Завершение…';});
        $('modelReport').textContent=modelReport.results.map(r=>r.skipped?r.algorithm+': не скачана':r.ok?`${r.algorithm}: OK · ${r.backend} · 2 кадра: ${r.twoFramesMs} ms · маска ${r.maskWidth} × ${r.maskHeight}`:`${r.algorithm}: ОШИБКА\n${r.error}`).join('\n\n');
        $('saveModelReport').disabled=false;
      }catch(e){$('modelReport').textContent=String(e.message||e);}
      finally{modelTestRunning=false;$('testModels').disabled=false;$('startPreview').disabled=false;}
    });
    $('saveModelReport').addEventListener('click',()=>{if(modelReport)saveJSON(modelReport,'aura-model-test.json');});
    window.addEventListener('pagehide',()=>stream?.getTracks().forEach(t=>t.stop()));
  }
  (async()=>{try{await load();const tabs=await chrome.tabs.query({active:true,currentWindow:true});tabId=tabs[0]?.id;await poll();statusTimer=setInterval(poll,1500);}catch(e){notice(e.message);}})();
  window.addEventListener('pagehide',()=>clearInterval(statusTimer));
})();
