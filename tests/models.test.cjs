'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),results=[];let calls=[],disposals=0,releases=0,gpuFail=false,forceNonFinite=false,mpMode='normal';
class Tensor{constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;}dispose(){disposals++;}}
const canvas=()=>({width:1,height:1,getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4).fill(128)})};}});
const context={console,Float32Array,Uint8ClampedArray,ArrayBuffer,URL,performance,Math,Number,Object,navigator:{gpu:{}},document:{createElement:()=>canvas()}};
context.globalThis=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root,'extension/core.js'),'utf8'),context);
context.ort={env:{wasm:{}},Tensor,InferenceSession:{async create(url,options){
 if(options.executionProviders.includes('webgpu')&&gpuFail)throw new Error('GPU_UNAVAILABLE');
 const rvm=url.includes('rvm_'),depth=url.includes('midas_');
 return {inputNames:rvm?['src','r1i','r2i','r3i','r4i','downsample_ratio']:['input'],outputNames:rvm?['fgr','pha','r1o','r2o','r3o','r4o']:['output'],
  async run(feeds){calls.push({url,feeds,options});
   if(rvm){const [b,c,h,w]=feeds.src.dims,v=feeds.r1i.data[0]+1;return {fgr:new Tensor('float32',new Float32Array(3*w*h),[1,3,h,w]),pha:new Tensor('float32',new Float32Array(w*h).fill(forceNonFinite?NaN:.5),[1,1,h,w]),...Object.fromEntries([1,2,3,4].map(n=>['r'+n+'o',new Tensor('float32',new Float32Array([v]),[1,1,1,1])]))};}
   const h=depth?256:feeds.input.dims[2],w=depth?256:feeds.input.dims[3];return {output:new Tensor('float32',new Float32Array(w*h).fill(depth?10:.5),depth?[1,h,w]:[1,1,h,w])};
  },async release(){releases++;}};
}}};
context.AuraWasmFactory=()=>{};
context.AuraVision={ImageSegmenter:{async createFromOptions(files,options){
 if(options.baseOptions.delegate==='GPU'&&gpuFail)throw new Error('GPU_UNAVAILABLE');
 const multi=options.baseOptions.modelAssetPath.includes('multiclass');
 return {close(){releases++;},segment(input,cb){const n=input.width*input.height;let vals=multi?[.25,.15,.15,.15,.15,.15]:[.25,.75];if(mpMode==='bad')vals=[1,0,0];cb({confidenceMasks:vals.map(v=>({width:input.width,height:input.height,getAsFloat32Array:()=>new Float32Array(n).fill(v)}))});}};
}}};
vm.runInContext(fs.readFileSync(path.join(root,'extension/models.js'),'utf8'),context);
const M=context.AuraModels,C=context.AuraCore,env={asset:p=>p,loadLibrary:async()=>{}},frame={width:160,height:96},opt=C.normalize({quality:'eco'});
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:e.stack});console.log('FAIL',name,e.message);}}
(async()=>{
 await test('RVM input RGB normalization [0,1], NCHW',()=>{const p=new Uint8ClampedArray([255,0,128,255]);const t=M.nchw(p,1,1);assert.equal(t[0],1);assert.equal(t[1],0);assert(Math.abs(t[2]-128/255)<1e-6);});
 await test('MODNet normalization [-1,1], not ImageNet mean',()=>{const t=M.nchw(new Uint8ClampedArray([255,0,128,255]),1,1,true);assert.equal(t[0],1);assert.equal(t[1],-1);assert(Math.abs(t[2]-1/255)<1e-6);});
 await test('Selfie selects person channel 1',async()=>{const r=await M.create('fast',opt,env);const a=await r.predict(frame,opt);assert.equal(a.data[0],.75);assert.equal(a.width,256);assert.equal(a.height,144);await r.close();});
 await test('SelfieMulticlass combines all person classes as 1-background',async()=>{const r=await M.create('multiclass',opt,env);const a=await r.predict(frame,opt);assert.equal(a.data[0],.75);assert.equal(a.height,256);assert.equal(a.matting,false);await r.close();});
 await test('Unexpected multiclass output fails instead of selecting a wrong class',async()=>{const r=await M.create('multiclass',opt,env);mpMode='bad';await assert.rejects(r.predict(frame,opt));mpMode='normal';await r.close();});
 await test('RVM recycles recurrent tensors across frames',async()=>{calls=[];const r=await M.create('rvm',opt,env);await r.predict(frame,opt);await r.predict(frame,opt);assert.equal(calls[0].feeds.r1i.data[0],0);assert.equal(calls[1].feeds.r1i.data[0],1);assert.equal(calls[1].feeds.downsample_ratio.type,'float32');await r.close();});
 await test('RVM recurrence is independent between cameras',async()=>{calls=[];const a=await M.create('rvm',opt,env),b=await M.create('rvm',opt,env);await a.predict(frame,opt);await a.predict(frame,opt);await b.predict(frame,opt);assert.equal(calls[2].feeds.r1i.data[0],0);await a.close();await b.close();});
 await test('RVM resets recurrence on size changes',async()=>{calls=[];const r=await M.create('rvm',opt,env);await r.predict(frame,opt);await r.predict({width:128,height:96},opt);assert.equal(calls[1].feeds.r1i.data[0],0);await r.close();});
 await test('RVM rejects nonfinite alpha, does not expose NaNs to compositor',async()=>{const r=await M.create('rvm',opt,env);forceNonFinite=true;await assert.rejects(r.predict(frame,opt));forceNonFinite=false;await r.close();});
 await test('MODNet dispatch uses its ONNX adapter, not MediaPipe',async()=>{calls=[];const r=await M.create('modnet',opt,env);const a=await r.predict(frame,opt);assert(calls[0].url.includes('modnet_webcam.onnx'));assert.equal(a.matting,true);assert.equal(a.data[0],.5);await r.close();});
 await test('Depth mode invokes distinct MiDaS inference',async()=>{calls=[];const r=await M.create('depth',opt,env);const a=await r.predict(frame,opt);assert(calls.some(c=>c.url.includes('midas_small.onnx')));assert.equal(a.depthInfo.width,256);assert.equal(a.depthInfo.applied,false);await r.close();});
 await test('MiDaS uses [0,1] RGB (official ONNX graph includes normalization)',async()=>{calls=[];const r=await M.create('depth',opt,env);await r.predict(frame,opt);const q=calls.find(c=>c.url.includes('midas')).feeds.input;assert(Math.abs(q.data[0]-128/255)<1e-6);assert.deepEqual([...q.dims],[1,3,256,256]);await r.close();});
 await test('Automatic accelerator falls back to CPU without changing algorithm',async()=>{gpuFail=true;const r=await M.create('rvm',opt,env);assert.equal(r.backend,'ONNX WASM / CPU');assert(r.warning.includes('GPU'));await r.predict(frame,opt);await r.close();const m=await M.create('multiclass',opt,env);assert.equal(m.backend,'MediaPipe CPU');await m.close();gpuFail=false;});
 await test('ORT dependencies are local, proxy/threads do not require relaxed page CSP',()=>{assert.equal(context.ort.env.wasm.numThreads,1);assert.equal(context.ort.env.wasm.proxy,false);assert.equal(context.ort.env.wasm.wasmPaths.mjs,'vendor/ort-wasm-simd-threaded.jsep.mjs');});
 await test('Tensor and session resources are disposed',()=>{assert(disposals>20);assert(releases>10);});
 fs.writeFileSync(path.join(__dirname,'models-report.json'),JSON.stringify({realModels:false,testDoubles:true,results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
})();
