"""Compare refiner CPU costs in Chromium, WITHOUT ML inference or a camera.

Usage: python3 tests/refiner_benchmark.py --baseline /path/to/0.4.0/aura-camera/extension/core.js
All inputs are deterministic synthetic data. Efficient mode uses a smaller alpha
work grid: this is a speed/detail tradeoff, not equal-quality end-to-end inference.
"""
from pathlib import Path
import argparse,base64,json,shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--baseline',type=Path,required=True);args=p.parse_args()
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page();page.set_content('<!doctype html><title>Filter benchmark</title>')
 page.add_script_tag(content=args.baseline.read_text());page.evaluate('globalThis.BaselineCore=globalThis.AuraCore')
 page.add_script_tag(content=(ROOT/'extension/core.js').read_text());page.add_script_tag(content=(ROOT/'extension/native-refiner.js').read_text())
 wasm=base64.b64encode((ROOT/'extension/native/refiner-simd.wasm').read_bytes()).decode()
 page.evaluate('''async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));globalThis.nativeModule=await WebAssembly.compile(bytes);}''',wasm)
 rows=page.evaluate('''() => {
   const C=AuraCore,rows=[];
   function rgb(w,h){const p=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let i=(y*w+x)*4;p[i]=Math.round(210*x/w);p[i+1]=Math.round(200*y/h);p[i+2]=Math.round(110+50*Math.sin(x/w*14));p[i+3]=255;}return p;}
   const mask={width:256,height:144,matting:false,data:new Float32Array(256*144)};
   for(let y=0;y<144;y++)for(let x=0;x<256;x++){const dx=(x-130)/75,dy=(y-85)/95;mask.data[y*256+x]=1-C.smooth(.75,1.12,Math.sqrt(dx*dx+dy*dy));}
   for(const [outW,outH,quality] of [[640,360,'balanced'],[1280,720,'high']]){
     for(const mode of ['baseline_JS','new_detail_WASM','new_efficient_JS','new_efficient_WASM']){
       const efficient=mode.includes('efficient'),native=mode.includes('WASM');
       const size=efficient?C.refinementSize(outW,outH,quality,'efficient'):{width:outW,height:outH};
       const guide=efficient?C.guideSize(size.width,size.height,quality,'efficient'):BaselineCore.fitLong(size.width,size.height,BaselineCore.PROFILES[quality].guide);
       const r=native?new AuraNative.NativeRefiner(nativeModule):new BaselineCore.RGBRefiner(),opts=C.normalize({quality,algorithm:'fast'});
       const full=rgb(size.width,size.height),gp=rgb(guide.width,guide.height),converted=new Uint8ClampedArray(size.width*size.height*4);converted.fill(255);
       const times=[];
       for(let j=0;j<45;j++){
         const t=performance.now(),alpha=r.refine(mask,full,size.width,size.height,gp,guide.width,guide.height,opts);
         if(!native)for(let i=0;i<alpha.length;i++)converted[i*4+3]=Math.round(alpha[i]*255);
         const elapsed=performance.now()-t;if(j>=10)times.push(elapsed);
       }
       times.sort((a,b)=>a-b);
       rows.push({mode,output:[outW,outH],work:[size.width,size.height],guide:[guide.width,guide.height],medianMs:+times[17].toFixed(2),p90Ms:+times[31].toFixed(2),samples:times.length});r.close();
     }
   }
   return rows;
 }''')
 report={'browser':browser.version,'platform':page.evaluate('navigator.userAgent'),'kind':'synthetic refiner + alpha->RGBA only; excludes neural inference, camera capture/readback, compositor, encoding, network',
  'warning':'Efficient mode uses a lower-resolution alpha working grid; this is NOT a same-quality comparison nor a real-call FPS benchmark. Native full-detail tests separately verify arithmetic equivalence.',
  'rows':rows}
 (ROOT/'tests/performance-report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
 print(json.dumps(report,indent=2,ensure_ascii=False));browser.close()
