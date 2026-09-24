'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
require('../extension/core.js');require('../extension/native-refiner.js');
const C=AuraCore,results=[];
const modules=['refiner-simd.wasm','refiner.wasm'].map(name=>({name,module:new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../extension/native',name)))}));
function test(name,fn){try{const details=fn();results.push({name,passed:true,details});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:e.stack});console.error('FAIL',name,e.message);}}
const rgb=(w,h,v=90)=>Uint8ClampedArray.from({length:w*h*4},(_,i)=>i%4===3?255:v);
function make(r,opts={}){const p=rgb(16,12);return {r,p,options:{...C.normalize({antiflicker:true,temporal:.4}),...opts},frame(v,brightness=90,extra={}){this.p.set(rgb(16,12,brightness));return r.refine({width:16,height:12,data:new Float32Array(192).fill(v),matting:true},this.p,16,12,this.p,16,12,{...this.options,...extra})[80];}};}
const backends=[['JS',()=>new C.RGBRefiner()],...modules.map(m=>[m.name,()=>new AuraNative.NativeRefiner(m.module)])];
for(const [name,factory] of backends){
 test(name+' no initial fade; alpha endpoints and fractional values preserved',()=>{for(const a of [0,1,.37]){const t=make(factory());for(let f=0;f<5;f++)assert(Math.abs(t.frame(a)-a)<1e-5);t.r.close();}});
 test(name+' rejects a one-frame background false positive after warmup',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(0);const spike=t.frame(1);assert.equal(spike,0);assert.equal(t.frame(0),0);t.r.close();return {spikeAlpha:spike};});
 test(name+' suppresses a one-frame foreground dropout after warmup',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(1);assert.equal(t.frame(0),1);assert.equal(t.frame(1),1);t.r.close();});
 test(name+' real RGB change releases history immediately',()=>{const t=make(factory());for(let f=0;f<5;f++)t.frame(1,30);assert.equal(t.frame(0,220),0);t.r.close();});
 test(name+' static persistent class change is not frozen indefinitely',()=>{for(const init of [0,1]){const t=make(factory());for(let f=0;f<4;f++)t.frame(init);let a;for(let f=0;f<6;f++)a=t.frame(1-init);assert(Math.abs(a-(1-init))<.04);t.r.close();}});
 test(name+' zero strength is an exact temporal bypass',()=>{const t=make(factory(),{temporal:0});for(let f=0;f<10;f++)assert.equal(t.frame(f%2),f%2);t.r.close();});
 test(name+' long frame gap resets old history',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(1);assert.equal(t.frame(0,90,{frameDeltaMs:350}),0);t.r.close();});
 test(name+' invalid/nonmonotonic frame timing resets history',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(1);assert.equal(t.frame(0,90,{frameDeltaMs:-1}),0);t.r.close();});
 test(name+' explicit reset and resize invalidate all candidates',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(1);t.r.reset();assert.equal(t.frame(0),0);const p=rgb(20,20);const m={width:20,height:20,data:new Float32Array(400).fill(1),matting:true};assert(t.r.refine(m,p,20,20,p,20,20,t.options).every(x=>x===1));t.r.close();});
 test(name+' switching back to legacy mode clears guarded history',()=>{const t=make(factory());for(let f=0;f<4;f++)t.frame(1);assert.equal(t.frame(0,90,{antiflicker:false}),0);t.r.close();});
 test(name+' independent sessions do not share history',()=>{const a=make(factory()),b=make(factory());for(let f=0;f<5;f++){assert.equal(a.frame(0),0);assert.equal(b.frame(1),1);}a.r.close();b.r.close();});
 test(name+' alpha jitter on stationary synthetic input lower than legacy',()=>{const t=make(factory()),legacy=make(factory(),{antiflicker:false}),n=[],o=[];for(let f=0;f<40;f++){let x=f<4?.5:(f%2?.55:.45);const a=t.frame(x),b=legacy.frame(x);if(f>15){n.push(a);o.push(b);}}const variation=a=>a.slice(1).reduce((s,x,i)=>s+Math.abs(x-a[i]),0)/(a.length-1);assert(variation(n)<variation(o)*.8);t.r.close();legacy.r.close();return {newMeanStep:variation(n),legacyMeanStep:variation(o),syntheticOnly:true};});
}
for(const m of modules)test(m.name+' new temporal path agrees with JavaScript across motion and mask types',()=>{
 let maxError=0;for(const matting of [true,false]){
  const a=new C.RGBRefiner(),b=new AuraNative.NativeRefiner(m.module),w=48,h=32,gw=24,gh=16,opt={...C.normalize({antiflicker:true,temporal:.45}),frameDeltaMs:50};
  for(let f=0;f<12;f++){
   const p=Uint8ClampedArray.from({length:w*h*4},(_,i)=>i%4===3?255:(i*17+(f===7?120:0))%256),g=rgb(gw,gh,100);
   const mask={width:16,height:12,matting,data:Float32Array.from({length:192},(_,i)=>f===5?0:C.unit(.5+.4*Math.sin(i/5+f*.02)))};
   const pa=p.slice(),ga=g.slice(),ma=mask.data.slice();
   const x=a.refine(mask,p,w,h,g,gw,gh,opt),y=b.refine(mask,p,w,h,g,gw,gh,opt);
   for(let i=0;i<x.length;i++)maxError=Math.max(maxError,Math.abs(x[i]-y[i]));
   assert.deepEqual(p,pa);assert.deepEqual(g,ga);assert.deepEqual(mask.data,ma);
  }a.close();b.close();
 }assert(maxError<1e-5);return {maxAlphaError:maxError};
});
test('Antiflicker preset preserves every other user setting',()=>{const s=C.normalize({algorithm:'fast',quality:'balanced',enabled:false,everywhere:false,meetEnabled:true,background:'office',edge:6,feather:.9,threshold:.58});const expected={...s,antiflicker:true,temporal:.4};assert.deepEqual(C.antiflickerPreset(s),expected);});
test('Old saved settings opt out of new guard until button is used',()=>assert.equal(C.normalize({temporal:.5}).antiflicker,false));
test('Time-based retention has equivalent decay for two 30Hz and one 15Hz step',()=>{const a=C.temporalParams({temporal:.4,frameDeltaMs:1000/30}).retention,b=C.temporalParams({temporal:.4,frameDeltaMs:1000/15}).retention;assert(Math.abs(a*a-b)<1e-8);});
test('No-model alpha filter preserves browser-side settings on migration',()=>{const s=C.normalize({algorithm:'depth',accelerator:'cpu',processing:'detail',temporal:.55});assert.equal(s.algorithm,'depth');assert.equal(s.temporal,.55);assert.equal(s.antiflicker,false);});
test('WASM ABI guard rejects unrelated/mixed compiled modules',()=>{const empty=new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));assert.throws(()=>new AuraNative.NativeRefiner(empty),/Версия WASM/);});
fs.writeFileSync(path.join(__dirname,'temporal-report.json'),JSON.stringify({results},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
