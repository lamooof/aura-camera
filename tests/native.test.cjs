'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
require('../extension/core.js');require('../extension/native-refiner.js');
const C=AuraCore,results=[];
function test(name,fn){try{const details=fn();results.push({name,passed:true,details});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:String(e.stack||e)});console.log('FAIL',name,e.message);}}
let seed=1007;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
function pixels(w,h){const v=new Uint8ClampedArray(w*h*4);for(let i=0;i<v.length;i++)v[i]=i%4===3?255:Math.floor(rand()*256);return v;}
const opt=C.normalize({quality:'high',algorithm:'rvm'});
for(const name of ['refiner-simd.wasm','refiner.wasm']){
 const module=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../extension/native',name)));
 test(name+' has no host imports',()=>assert.equal(WebAssembly.Module.imports(module).length,0));
 for(const matting of [false,true])for(const size of [[32,18,16,9],[100,58,40,24],[320,180,128,72]]){
  test(name+' matches JS '+size.join('x')+' matting='+matting,()=>{
   const [w,h,gw,gh]=size,r=new C.RGBRefiner(),nr=new AuraNative.NativeRefiner(module),mask={width:24,height:16,matting,data:Float32Array.from({length:384},()=>rand())};
   let maxError=0,rgbaError=0;
   for(let frame=0;frame<3;frame++){
    const rgb=pixels(w,h),grgb=pixels(gw,gh);
    const expected=r.refine(mask,rgb,w,h,grgb,gw,gh,opt),actual=nr.refine(mask,rgb,w,h,grgb,gw,gh,opt);
    for(let i=0;i<actual.length;i++){maxError=Math.max(maxError,Math.abs(actual[i]-expected[i]));rgbaError=Math.max(rgbaError,Math.abs(nr.views.rgba[4*i+3]-Math.round(expected[i]*255)));}
   }
   assert(maxError<1e-5,'alpha mismatch '+maxError);assert(rgbaError<=1,'RGBA mismatch '+rgbaError);nr.close();r.close();return {maxError,rgbaError};
  });
 }
 for(const value of [0,1,.5])test(name+' constant alpha '+value,()=>{
   const nr=new AuraNative.NativeRefiner(module),p=pixels(32,24),mask={width:16,height:12,data:new Float32Array(192).fill(value),matting:true};
   for(let f=0;f<3;f++)assert(nr.refine(mask,p,32,24,p,32,24,opt).every(x=>Math.abs(x-value)<1e-5));nr.close();
 });
 test(name+' resizing resets history and remains valid',()=>{
  const nr=new AuraNative.NativeRefiner(module);
  for(const [w,h] of [[80,60],[320,180],[32,24]]){const p=pixels(w,h),mask={width:16,height:12,matting:true,data:new Float32Array(192).fill(1)};assert(nr.refine(mask,p,w,h,p,w,h,opt).every(x=>x===1));}nr.close();
 });
 test(name+' malformed dimensions and closed instance rejected',()=>{const nr=new AuraNative.NativeRefiner(module);assert.throws(()=>nr.layout(16,16,99999,1,2,2));assert.throws(()=>nr.refine({data:new Float32Array(1),width:2,height:2},[],1,1,[],1,1,opt));nr.close();assert.throws(()=>nr.refine({},[],1,1,[],1,1,opt));});
}
test('Efficient working mask bounded while high RGB output remains 720p',()=>{assert.deepEqual(C.fitSize(1920,1080,'high'),{width:1280,height:720,fps:25});assert.deepEqual(C.refinementSize(1280,720,'high','efficient'),{width:640,height:360});});
test('Detail mode keeps full-resolution 0.4.0 reconstruction',()=>assert.deepEqual(C.refinementSize(1280,720,'high','detail'),{width:1280,height:720}));
test('RVM WASM speed budget bounded to 512/core 256',()=>assert.deepEqual(C.modelBudget('rvm','ultra','efficient','ONNX WASM / CPU'),{limit:512,core:256}));
test('RVM detail mode retains 960/core 384',()=>assert.deepEqual(C.modelBudget('rvm','ultra','detail','ONNX WASM / CPU'),{limit:960,core:384}));
test('Speed preset preserves background, disabled effect and Meet exclusion',()=>{const s=C.speedPreset(C.normalize({enabled:false,background:'office',meetEnabled:false,everywhere:true,algorithm:'depth',quality:'ultra'}));assert.equal(s.enabled,false);assert.equal(s.background,'office');assert.equal(s.meetEnabled,false);assert.equal(s.everywhere,true);assert.equal(s.algorithm,'fast');assert.equal(s.processing,'efficient');});
fs.writeFileSync(path.join(__dirname,'native-report.json'),JSON.stringify({results},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
