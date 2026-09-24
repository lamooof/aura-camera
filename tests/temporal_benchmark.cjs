'use strict';
// Synthetic RGB+alpha filter benchmark, no camera and no neural model execution.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');require('../extension/core.js');require('../extension/native-refiner.js');
const C=AuraCore,native=new WebAssembly.Module(fs.readFileSync(root+'/extension/native/refiner-simd.wasm'));
const w=640,h=360,gw=256,gh=144;
const pixels=(w,h)=>Uint8ClampedArray.from({length:w*h*4},(_,i)=>i%4===3?255:80+Math.floor(40*Math.sin((i>>2)/50)));
const p=pixels(w,h),g=pixels(gw,gh),mask={width:256,height:144,matting:true,data:Float32Array.from({length:256*144},(_,i)=>C.smooth(0,1,(i%256)/256))};
const variants=[{label:'0.4.2 guard off',r:new AuraNative.NativeRefiner(native),opt:{...C.normalize(),temporal:.4,antiflicker:false}},
 {label:'0.4.2 guard on (40%)',r:new AuraNative.NativeRefiner(native),opt:{...C.normalize(),temporal:.4,antiflicker:true,frameDeltaMs:50}}];
const oldRoot=process.argv[2];
if(oldRoot){
 const ctx={console,Float32Array,Uint8Array,Uint8ClampedArray,ArrayBuffer,WebAssembly,URL,performance,Math,Number,Object};ctx.globalThis=ctx;vm.createContext(ctx);
 for(const file of ['core.js','native-refiner.js'])vm.runInContext(fs.readFileSync(path.join(oldRoot,'extension',file),'utf8'),ctx);
 const oldModule=new WebAssembly.Module(fs.readFileSync(path.join(oldRoot,'extension/native/refiner-simd.wasm')));
 variants.unshift({label:'0.4.1 guard off',r:new ctx.AuraNative.NativeRefiner(oldModule),opt:{...ctx.AuraCore.normalize(),temporal:.4}});
 // Opt-out matches the actual previous bundle on the same input, not just new JS.
 const a=variants[0].r.refine(mask,p,w,h,g,gw,gh,variants[0].opt).slice();
 const b=variants[1].r.refine(mask,p,w,h,g,gw,gh,variants[1].opt);
 assert(a.every((v,i)=>Math.abs(v-b[i])<1e-6));
}
for(let j=0;j<5;j++)for(const v of variants)v.r.refine(mask,p,w,h,g,gw,gh,v.opt);
for(const v of variants)v.ms=[];
for(let j=0;j<45;j++){
 for(const v of j%2?variants.toReversed():variants){let t=performance.now();v.r.refine(mask,p,w,h,g,gw,gh,v.opt);v.ms.push(performance.now()-t);}
}
const result={environment:process.version,kind:'Node V8, genuine SIMD WASM; synthetic RGB and alpha, no neural inference',work:[w,h],guide:[gw,gh],samples:45,results:variants.map(v=>{
 v.ms.sort((a,b)=>a-b);v.r.close();return {variant:v.label,medianMs:v.ms[22],p95Ms:v.ms[42]};
})};
fs.writeFileSync(path.join(__dirname,'temporal-performance-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
