/* Aura Camera 0.4.2: private, bounded WASM memory for the same RGB guided filter.
 * No camera/network access in WASM. Only this small wrapper loads bundled code.
 * SIMD -> scalar WASM -> original JavaScript fallback. No remote executable code.
 */
(() => {
  'use strict';
  const C=globalThis.AuraCore;
  let compiled=null;
  class NativeRefiner {
    constructor(module,backend='WASM'){
      this.instance=new WebAssembly.Instance(module,{});
      if(this.instance.exports.refiner_abi?.()!==2)throw new Error('Версия WASM-фильтра не совпала с кодом 0.4.2. Обновите файлы целиком.');
      this.guardMode=null;
      this.memory=this.instance.exports.memory;this.backend=backend;
      this.historyValid=false;this.key='';this.views=null;this.imageData=null;
    }
    reset(){this.historyValid=false;}
    close(){this.views=null;this.imageData=null;this.memory=null;this.instance=null;this.key='';this.historyValid=false;}
    layout(mw,mh,w,h,gw,gh){
      for(const n of [mw,mh,w,h,gw,gh])if(!Number.isInteger(n)||n<1||n>4096)throw new Error('Некорректный размер WASM-маски');
      if(w*h>2073600||mw*mh>2073600||gw*gh>1048576)throw new Error('Слишком большой буфер RGB-фильтра');
      const key=[mw,mh,w,h,gw,gh].join('/');if(this.key===key)return;
      const n=gw*gh,N=w*h,oldKey=this.key;
      let offset=Math.ceil(this.instance.exports.heap_base()/16)*16;
      const entries={};
      function alloc(name,Type,length){entries[name]={offset,Type,length};offset+=Math.ceil(length*Type.BYTES_PER_ELEMENT/16)*16;}
      alloc('mask',Float32Array,mw*mh);alloc('full',Uint8Array,N*4);alloc('guide',Uint8Array,n*4);
      alloc('scratch',Float32Array,n*27+w*3);alloc('previous',Float32Array,N);alloc('previousRGB',Float32Array,N*3);
      alloc('alpha',Float32Array,N);alloc('rgba',Uint8ClampedArray,N*4);
      alloc('raw1',Float32Array,N);alloc('raw2',Float32Array,N);alloc('age',Float32Array,N);
      if(offset>128*1024*1024)throw new Error('Превышен лимит памяти фильтра');
      if(offset>this.memory.buffer.byteLength)this.memory.grow(Math.ceil((offset-this.memory.buffer.byteLength)/65536));
      this.views=Object.fromEntries(Object.entries(entries).map(([name,e])=>[name,new e.Type(this.memory.buffer,e.offset,e.length)]));
      this.imageData=typeof ImageData==='function'?new ImageData(this.views.rgba,w,h):null;
      this.key=key;this.historyValid=false;
    }
    refine(mask,fullRGB,w,h,guideRGB,gw,gh,options){
      if(!this.instance)throw new Error('RGB-фильтр закрыт');
      if(mask.data.length!==mask.width*mask.height||fullRGB.length!==w*h*4||guideRGB.length!==gw*gh*4)throw new Error('Несовпадение размеров RGB/маски');
      this.layout(mask.width,mask.height,w,h,gw,gh);
      const a=this.views,tp=C.temporalParams(options);
      if(tp.guard!==this.guardMode||(tp.guard&&tp.reset))this.historyValid=false;
      this.guardMode=tp.guard;
      a.mask.set(mask.data);a.full.set(fullRGB);a.guide.set(guideRGB);
      this.instance.exports.refine(a.mask.byteOffset,mask.width,mask.height,a.full.byteOffset,w,h,a.guide.byteOffset,gw,gh,
        options.edge,options.threshold,options.temporal,mask.matting?1:0,this.historyValid?1:0,
        a.scratch.byteOffset,a.previous.byteOffset,a.previousRGB.byteOffset,a.alpha.byteOffset,a.rgba.byteOffset,
        tp.guard?1:0,tp.retention,tp.medianWeight,a.raw1.byteOffset,a.raw2.byteOffset,a.age.byteOffset);
      this.historyValid=true;return a.alpha;
    }
  }
  async function load(asset){
    if(!compiled)compiled=(async()=>{
      const errors=[];
      for(const [name,backend] of [['refiner-simd.wasm','WASM SIMD'],['refiner.wasm','WASM']]){
        try{
          const res=await fetch(asset('native/'+name));if(!res.ok)throw new Error('HTTP '+res.status);
          const module=await WebAssembly.compile(await res.arrayBuffer());
          if(WebAssembly.Module.imports(module).length)throw new Error('Неожиданные импорты в фильтре');
          return {module,backend};
        }catch(e){errors.push(String(e.message||e));}
      }
      throw new Error('Локальный WASM-фильтр недоступен: '+errors.join('; '));
    })();
    return compiled;
  }
  async function create(asset){const {module,backend}=await load(asset);return new NativeRefiner(module,backend);}
  globalThis.AuraNative=Object.freeze({create,NativeRefiner});
})();
