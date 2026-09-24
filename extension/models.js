/* Local, switchable inference adapters. No remote imports or downloads at runtime.
 * Pinned model contracts and preprocessing are documented in RESEARCH.md.
 */
(() => {
  'use strict';
  if(globalThis.AuraModels)return;
  const C=globalThis.AuraCore;
  let mpQueue=Promise.resolve(),ortQueue=Promise.resolve(),ortConfigured=false;
  function canvas(w=1,h=1){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
  function rgba(source,c,w,h){
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(source,0,0,w,h);return ctx.getImageData(0,0,w,h).data;
  }
  function nchw(pixels,w,h,minusOne=false){
    if(pixels.length!==w*h*4)throw new Error('Некорректный RGB-тензор');
    const n=w*h,data=new Float32Array(3*n),scale=minusOne?2/255:1/255,offset=minusOne?1:0;
    for(let i=0;i<n;i++){data[i]=pixels[i*4]*scale-offset;data[n+i]=pixels[i*4+1]*scale-offset;data[n*2+i]=pixels[i*4+2]*scale-offset;}
    return data;
  }
  function alphaTensor(t){
    if(!t||t.type!=='float32'||!Array.isArray(t.dims))throw new Error('Модель вернула неподдерживаемый тип маски');
    const d=t.dims,h=d[d.length-2],w=d[d.length-1];
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h!==t.data.length)throw new Error('Модель вернула неподдерживаемую форму маски');
    const a=new Float32Array(t.data);
    if(a.some(v=>!Number.isFinite(v)))throw new Error('Модель вернула NaN/Infinity');
    return {data:a,width:w,height:h};
  }
  function disposeTensors(values){for(const t of new Set(values.filter(Boolean)))t.dispose?.();}

  async function createMP(kind,opts,env){
    await env.loadLibrary('mp');
    if(!globalThis.AuraVision?.ImageSegmenter||typeof globalThis.AuraWasmFactory!=='function')throw new Error('MediaPipe не подготовлен: выполните python3 prepare.py');
    const model=kind==='fast'?'selfie_segmenter_landscape.tflite':'selfie_multiclass_256x256.tflite';
    let task,backend='',warning='';
    const make=async delegate=>{
      globalThis.Module=undefined;globalThis.ModuleFactory=globalThis.AuraWasmFactory;
      return globalThis.AuraVision.ImageSegmenter.createFromOptions({wasmLoaderPath:null,wasmBinaryPath:env.asset('vendor/vision_wasm_internal.wasm')},{
        baseOptions:{modelAssetPath:env.asset('models/'+model),delegate},runningMode:'IMAGE',outputConfidenceMasks:true,outputCategoryMask:false
      });
    };
    const work=async()=>{
      if(opts.accelerator==='auto'){
        try{task=await make('GPU');backend='MediaPipe GPU';}catch(e){warning='GPU MediaPipe недоступен; используется CPU: '+String(e.message||e).slice(0,200);}
      }
      if(!task){task=await make('CPU');backend='MediaPipe CPU';}
    };
    const job=mpQueue.catch(()=>{}).then(work);mpQueue=job;await job;
    const input=canvas(256,kind==='fast'?144:256);
    let closed=false;
    return {
      get backend(){return backend;},get warning(){return warning;},reset(){},
      async predict(frame){
        if(closed)throw new Error('Модель закрыта');
        const ctx=input.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(frame,0,0,input.width,input.height);
        let result;
        const infer=()=>task.segment(input,r=>{
          const m=r.confidenceMasks;
          if(kind==='fast'){
            if(!m||(m.length!==1&&m.length!==2))throw new Error('Неверное число классов Selfie Segmenter');
            const p=m[m.length-1];result={data:new Float32Array(p.getAsFloat32Array()),width:p.width,height:p.height,matting:false};
          }else{
            if(!m||m.length!==6)throw new Error('SelfieMulticlass должен вернуть 6 классов');
            const bg=m[0],a=bg.getAsFloat32Array();result={data:Float32Array.from(a,x=>C.unit(1-x)),width:bg.width,height:bg.height,matting:false};
          }
        });
        try{infer();}catch(e){
          if(backend!=='MediaPipe GPU')throw e;
          task.close();const fallback=mpQueue.catch(()=>{}).then(()=>make('CPU'));mpQueue=fallback;task=await fallback;backend='MediaPipe CPU';warning='Ошибка GPU; выполнен переход на CPU: '+String(e.message||e).slice(0,200);infer();
        }
        if(!result||result.data.some(x=>!Number.isFinite(x)))throw new Error('Не удалось получить конечную маску человека');
        return result;
      },
      async close(){if(closed)return;closed=true;task.close();input.width=1;}
    };
  }
  async function createORT(kind,opts,env){
    await env.loadLibrary('ort');const ort=globalThis.ort;
    if(!ort?.InferenceSession)throw new Error('ONNX Runtime не подготовлен: выполните python3 prepare.py --all');
    if(!ortConfigured){
      // numThreads=1 avoids relying on SharedArrayBuffer/COOP/COEP of visited sites.
      // Explicit paths also prevent ORT from constructing Blob-based cross-origin loaders.
      ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
      ort.env.wasm.wasmPaths={mjs:env.asset('vendor/ort-wasm-simd-threaded.jsep.mjs'),wasm:env.asset('vendor/ort-wasm-simd-threaded.jsep.wasm')};
      ort.env.logLevel='warning';ortConfigured=true;
    }
    const filename={rvm:'rvm_mobilenetv3_fp32.onnx',modnet:'modnet_webcam.onnx',depth:'midas_small.onnx'}[kind];
    let session,backend='',warning='',closed=false,rec=[],signature='';
    const reset=()=>{disposeTensors(rec);rec=[];signature='';};
    const make=async providers=>ort.InferenceSession.create(env.asset('models/'+filename),{executionProviders:providers,graphOptimizationLevel:'all'});
    const work=async()=>{
      if(opts.accelerator==='auto'&&globalThis.navigator?.gpu){
        try{session=await make(['webgpu','wasm']);backend='ONNX WebGPU + WASM';}catch(e){warning='WebGPU недоступен для модели; используется WASM: '+String(e.message||e).slice(0,200);}
      }
      if(!session){session=await make(['wasm']);backend='ONNX WASM / CPU';}
    };
    const job=ortQueue.catch(()=>{}).then(work);ortQueue=job;await job;
    const input=canvas();
    const checkNames=()=>{
      if(kind==='rvm'){
        if(!['src','r1i','r2i','r3i','r4i','downsample_ratio'].every(n=>session.inputNames.includes(n))||!['pha','r1o','r2o','r3o','r4o'].every(n=>session.outputNames.includes(n)))throw new Error('Несовместимая RVM-модель');
      }else if(session.inputNames.length!==1)throw new Error('Ожидается модель с одним RGB-входом');
    };
    try{checkNames();}catch(e){await session.release();throw e;}
    async function run(feeds){
      try{return await session.run(feeds);}catch(e){
        if(backend!=='ONNX WebGPU + WASM')throw e;
        await session.release();session=await make(['wasm']);backend='ONNX WASM / CPU';
        warning='Ошибка WebGPU; та же модель запущена на CPU: '+String(e.message||e).slice(0,200);
        return session.run(feeds);
      }
    }
    return {
      get backend(){return backend;},get warning(){return warning;},reset,
      async predict(frame,settings=opts){
        if(closed)throw new Error('Модель закрыта');
        const budget=C.modelBudget(kind,settings.quality,settings.processing,backend),size=kind==='depth'?{width:256,height:256}:C.fitLong(frame.width,frame.height,budget.limit,kind==='modnet'?32:2);
        let {width:w,height:h}=size;
        // A fixed-shape export must be fed that shape; dynamic exports use the profile above.
        const meta=session.inputMetadata?.[0];
        const dims=meta?.shape||meta?.dimensions;
        if(kind!=='rvm'&&Array.isArray(dims)&&Number.isInteger(dims[2])&&dims[2]>0&&Number.isInteger(dims[3])&&dims[3]>0){h=dims[2];w=dims[3];}
        const pixels=rgba(frame,input,w,h),src=new ort.Tensor('float32',nchw(pixels,w,h,kind==='modnet'),[1,3,h,w]);
        let feeds,ratioTensor,outputs;
        if(kind==='rvm'){
          const ratio=Math.min(1,budget.core/Math.max(w,h)),key=`${w}/${h}/${ratio}`;
          if(signature!==key){reset();signature=key;}
          if(!rec.length)rec=Array.from({length:4},()=>new ort.Tensor('float32',new Float32Array(1),[1,1,1,1]));
          ratioTensor=new ort.Tensor('float32',new Float32Array([ratio]),[1]);
          feeds={src,r1i:rec[0],r2i:rec[1],r3i:rec[2],r4i:rec[3],downsample_ratio:ratioTensor};
        }else feeds={[session.inputNames[0]]:src};
        try{
          outputs=await run(feeds);
          if(kind==='rvm'){
            const result=alphaTensor(outputs.pha),next=['r1o','r2o','r3o','r4o'].map(n=>outputs[n]);
            if(next.some(t=>!t||t.type!=='float32'))throw new Error('RVM не вернула рекуррентное состояние');
            disposeTensors(rec);rec=next;
            disposeTensors(Object.values(outputs).filter(t=>!rec.includes(t)));
            outputs=null;return {...result,matting:true};
          }
          const result=alphaTensor(outputs[session.outputNames[0]]);
          // Official MiDaS v2.1 ONNX graph includes ImageNet normalization; input above is RGB [0,1].
          return {...result,matting:kind==='modnet',inverseDepth:kind==='depth'};
        }catch(e){if(kind==='rvm')reset();throw e;}
        finally{src.dispose?.();ratioTensor?.dispose?.();if(outputs)disposeTensors(Object.values(outputs));}
      },
      async close(){if(closed)return;closed=true;reset();await session.release();input.width=1;}
    };
  }
  async function createDepth(opts,env){
    const segmenter=await createMP('multiclass',opts,env);let estimator;
    try{estimator=await createORT('depth',opts,env);}catch(e){await segmenter.close();throw e;}
    const input=canvas(256,256);let last=null,reference=null,at=-Infinity,lastDepthMs=0;
    return {
      get backend(){return segmenter.backend+' + '+estimator.backend;},get warning(){return [segmenter.warning,estimator.warning].filter(Boolean).join('; ');},
      reset(){last=null;reference=null;at=-Infinity;},
      async predict(frame,settings){
        const result=await segmenter.predict(frame);
        if(settings.depthStrength<=0)return {...result,depthInfo:{applied:false,reason:'Влияние глубины 0: расчёт MiDaS пропущен',modelMs:0,ageMs:0,width:0,height:0}};
        const pixels=rgba(frame,input,256,256),now=performance.now();
        if(!last||now-at>=settings.depthInterval){
          const started=performance.now();last=await estimator.predict(input,settings);lastDepthMs=performance.now()-started;
          reference=new Uint8ClampedArray(pixels);at=performance.now();
        }
        const age=performance.now()-at;
        const info=C.depthFuse(result,last,pixels,reference,256,256,settings.depthStrength,age);
        return {...result,depthInfo:{...info,modelMs:Math.round(lastDepthMs),ageMs:Math.round(age),width:last?.width||0,height:last?.height||0}};
      },
      async close(){last=null;reference=null;input.width=1;await segmenter.close();await estimator.close();}
    };
  }
  async function create(kind,options,env){
    if(!Object.hasOwn(C.ALGORITHMS,kind))throw new Error('Неизвестный алгоритм');
    if(kind==='fast'||kind==='multiclass')return createMP(kind,options,env);
    if(kind==='depth')return createDepth(options,env);
    return createORT(kind,options,env);
  }
  globalThis.AuraModels=Object.freeze({create,nchw,alphaTensor});
})();
