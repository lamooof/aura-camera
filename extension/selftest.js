/* Local dependency/inference smoke test. No camera, no settings writes, no websites. */
(() => {
 'use strict';
 globalThis.AuraSelfTest={async run(onProgress=()=>{}){
   const report={version:AuraCore.VERSION,kind:'synthetic-inference-smoke-test',cameraUsed:false,qualityComparison:false,
     userAgent:navigator.userAgent,at:new Date().toISOString(),results:[]};
   const frame=document.createElement('canvas');frame.width=320;frame.height=192;
   const ctx=frame.getContext('2d');ctx.fillStyle='#666f78';ctx.fillRect(0,0,320,192);ctx.fillStyle='#dbb79b';ctx.beginPath();ctx.ellipse(160,72,32,42,0,0,2*Math.PI);ctx.fill();ctx.fillStyle='#293944';ctx.fillRect(115,114,90,78);
   for(const kind of Object.keys(AuraCore.ALGORITHMS)){
     if(!AuraBuild.installed[kind]){report.results.push({algorithm:kind,skipped:true,reason:'Модель не скачана'});continue;}
     let runner;onProgress(AuraCore.ALGORITHMS[kind].name);const start=performance.now();
     try{
       const opts=AuraCore.normalize({algorithm:kind,quality:'eco',accelerator:'auto'});
       runner=await AuraPreviewEngine.createTestModel(kind,opts);const loadMs=performance.now()-start,started=performance.now();
       const one=await runner.predict(frame,opts);const two=await runner.predict(frame,opts);
       if(!one?.data?.length||!two?.data?.length||two.data.some(x=>!Number.isFinite(x)||x<-.01||x>1.01))throw new Error('Неверная маска при тестовом выводе');
       if(kind==='depth'&&!(two.depthInfo?.width>0))throw new Error('Карта глубины не рассчитана');
       report.results.push({algorithm:kind,ok:true,backend:runner.backend,warning:runner.warning,loadMs:Math.round(loadMs),twoFramesMs:Math.round(performance.now()-started),maskWidth:two.width,maskHeight:two.height,depthInfo:two.depthInfo||null});
     }catch(e){report.results.push({algorithm:kind,ok:false,error:String(e.message||e)});}
     finally{try{await runner?.close();}catch{/* Preserve the inference result. */}}
   }
   frame.width=frame.height=1;onProgress('');return report;
 }};
})();
