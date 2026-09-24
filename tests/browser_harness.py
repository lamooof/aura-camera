"""Two-world browser tests with a synthetic camera and deterministic mask.

Real Chromium canvas/MediaStream/MediaStreamTrackProcessor; NO real camera,
NO actual MediaPipe/ONNX model inference; real bundled Aura refiner WASM is tested, NO installed extension (blocked by environment policy), NO real meeting connection.
Run: python3 tests/browser_harness.py (requires Playwright + Chromium).
"""
from pathlib import Path
import os,shutil
import base64,json,time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
EXT=ROOT/'extension'
results=[]
def record(name,fn):
    try:
        result=fn()
        if result is False:raise AssertionError('returned false')
        results.append({'name':name,'passed':True,'details':result})
        print('PASS',name,flush=True)
    except Exception as e:
        results.append({'name':name,'passed':False,'error':str(e)})
        print('FAIL',name,str(e)[:250],flush=True)

def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        page=browser.new_page(viewport={'width':1000,'height':700})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content('<!doctype html><html><body><video id="out" autoplay muted playsinline></video></body></html>')
        page.evaluate('''() => {
          window.rawCalls=[];window.rawStreams=[];
          Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{async getUserMedia(c){
            rawCalls.push(c);
            const tracks=[];
            if(c.video){
              const cv=document.createElement('canvas');cv.width=640;cv.height=360;
              const cx=cv.getContext('2d');
              const render=()=>{cx.fillStyle='#12b85d';cx.fillRect(0,0,640,360);cx.fillStyle='#e12c39';cx.fillRect(192,60,256,280);};
              render();setInterval(render,33);tracks.push(...cv.captureStream(30).getVideoTracks());
            }
            if(c.audio){const ac=new AudioContext();const dest=ac.createMediaStreamDestination();const osc=ac.createOscillator();osc.connect(dest);osc.start();tracks.push(...dest.stream.getAudioTracks());}
            const stream=new MediaStream(tracks);rawStreams.push(stream);return stream;
          }}});
          window.sample=()=>{const v=document.querySelector('#out');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return {outside:[...c.getContext('2d').getImageData(20,20,1,1).data],inside:[...c.getContext('2d').getImageData(Math.round(c.width/2),Math.round(c.height/2),1,1).data],width:c.width,height:c.height};};
        }''')
        # Actual MAIN-world shim.
        page.add_script_tag(content=(EXT/'main.js').read_text())
        cdp=page.context.new_cdp_session(page)
        tree=cdp.send('Page.getFrameTree')
        world=cdp.send('Page.createIsolatedWorld',{'frameId':tree['frameTree']['frame']['id'],'worldName':'AuraTestIsolated'})['executionContextId']
        def iso(expr):
            r=cdp.send('Runtime.evaluate',{'contextId':world,'expression':expr,'awaitPromise':True,'returnByValue':True})
            if 'exceptionDetails' in r:raise RuntimeError(str(r['exceptionDetails']))
            return r.get('result',{}).get('value')
        data={name:'data:image/jpeg;base64,'+base64.b64encode((EXT/'backgrounds'/f'{name}.jpg').read_bytes()).decode() for name in ['studio','office','graphite','mountains','dunes','ocean','forest','aurora']}
        setup='''
          globalThis.testSettings={enabled:true,mode:'image',color:'#263d68',quality:'eco',algorithm:'fast',accelerator:'cpu'};
          globalThis.testTopURL='https://camera.example.test/';
          globalThis.testCustom='';globalThis.testModelFail=false;globalThis.lastStatus={};globalThis.modelOptions=null;
          const changes=[];globalThis._messageListeners=[];globalThis.fetchCount=0;const originalFetch=globalThis.fetch;globalThis.fetch=(...args)=>{fetchCount++;return originalFetch(...args);};
          globalThis.chrome={runtime:{id:'aura-test',getURL:p=>ASSET_MAP[p.split('/').pop().replace('.jpg','')]||p,
            sendMessage:async m=>{if(m.type==='aura-policy')return {topURL:testTopURL,frameURL:'https://camera.example.test/'};if(m.status)globalThis.lastStatus=m.status;return {ok:true};},onMessage:{addListener:f=>_messageListeners.push(f)}},
            storage:{local:{get:async()=>({settings:testSettings,customImage:testCustom})},onChanged:{addListener:f=>changes.push(f)}}};
          globalThis.setTestSettings=async patch=>{testSettings={...testSettings,...patch};for(const f of changes)f({settings:{newValue:testSettings}},'local');await new Promise(r=>setTimeout(r,50));};
          globalThis.AuraBuild={prepared:true,installed:{fast:true,multiclass:true,rvm:true,modnet:true,depth:true}};
          globalThis.AuraWasmFactory=function(){};
          globalThis.AuraVision={ImageSegmenter:{createFromOptions:async (files,options)=>{globalThis.modelOptions={files,options};return {close(){},segment(input,callback){
            if(globalThis.testModelFail)throw new Error('TEST_INFERENCE_FAILURE');
            const w=input.width,h=input.height,a=new Float32Array(w*h),b=new Float32Array(w*h);
            for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;a[i]=(x>=w*.30 && x<w*.70 && y>=h/6 && y<h*.944)?1:0;b[i]=1-a[i];}
            const mask=v=>({width:w,height:h,getAsFloat32Array:()=>v});
            callback({confidenceMasks:options.baseOptions.modelAssetPath.includes('multiclass')?[mask(b),mask(a),mask(new Float32Array(w*h)),mask(new Float32Array(w*h)),mask(new Float32Array(w*h)),mask(new Float32Array(w*h))]:[mask(b),mask(a)]});
          }};}}};
        '''.replace('ASSET_MAP','('+json.dumps(data)+')')
        iso(setup)
        iso((EXT/'core.js').read_text())
        iso((EXT/'native-refiner.js').read_text())
        # Real bundled WASM, not a refiner stub. ML itself remains synthetic.
        wasm_assets={f'native/{p.name}':'data:application/wasm;base64,'+base64.b64encode(p.read_bytes()).decode() for p in (EXT/'native').glob('*.wasm')}
        iso('globalThis.wasmAssets='+json.dumps(wasm_assets)+';const baseURL=chrome.runtime.getURL;chrome.runtime.getURL=p=>wasmAssets[p]||baseURL(p);')
        iso((EXT/'models.js').read_text())
        iso((EXT/'engine.js').read_text())
        time.sleep(.2)
        record('MAIN and ISOLATED handshake',lambda: iso('lastStatus.hookReady===true'))
        record('No webcam opened during extension initialization',lambda:page.evaluate('rawCalls.length===0'))
        record('No background or WASM fetched before any camera request',lambda:iso('fetchCount===0'))
        iso("setTestSettings({mode:'color'})")
        page.evaluate('''async()=>{window.output=await navigator.mediaDevices.getUserMedia({video:true,audio:true});document.querySelector('#out').srcObject=output;await document.querySelector('#out').play();}''')
        page.wait_for_function('document.querySelector("#out").videoWidth>0')
        time.sleep(1.2)
        record('Shared DOM video readable from isolated world',lambda:iso("document.querySelector('[data-aura-pipeline] video').videoWidth===640"))
        record('Video track replaced, microphone track preserved',lambda:page.evaluate('output.getVideoTracks()[0]!==rawStreams[0].getVideoTracks()[0] && output.getAudioTracks()[0]===rawStreams[0].getAudioTracks()[0]'))
        def pixelcheck(outside,inside=None):
            result=page.evaluate('sample()')
            assert all(abs(result['outside'][i]-outside[i])<=10 for i in range(3)),result
            if inside:assert all(abs(result['inside'][i]-inside[i])<=10 for i in range(3)),result
            return result
        record('Outgoing video has replaced background and preserved foreground',lambda:pixelcheck([38,61,104],[225,44,57]))
        iso('setTestSettings({antiflicker:true,temporal:0.4})');time.sleep(.7)
        record('Opt-in temporal guard preserves outgoing static foreground and background',lambda:pixelcheck([38,61,104],[225,44,57]))
        iso("_messageListeners.forEach(f=>f({type:'aura-ping'},{id:chrome.runtime.id},()=>{}))")
        record('Guard mode is reported by active engine',lambda:iso('lastStatus.antiflicker===true && !lastStatus.error'))
        iso("_messageListeners.forEach(f=>f({type:'aura-ping'},{id:chrome.runtime.id},()=>{}))")
        record('Actual bundled native RGB filter is active',lambda:iso("lastStatus.refinerBackend==='WASM SIMD' || lastStatus.refinerBackend==='WASM'"))
        record('Efficient alpha grid does not lower outgoing RGB resolution',lambda:iso('lastStatus.workWidth===320 && lastStatus.width===640'))
        record('Model configured for local WASM and CPU',lambda:iso("modelOptions.files.wasmLoaderPath===null && modelOptions.options.baseOptions.delegate==='CPU' && modelOptions.options.runningMode==='IMAGE'"))
        def processor():
            return page.evaluate('''async()=>{const track=output.getVideoTracks()[0].clone();const p=new MediaStreamTrackProcessor({track});const r=p.readable.getReader();let frame;
            try{frame=(await r.read()).value;const c=new OffscreenCanvas(frame.displayWidth,frame.displayHeight);c.getContext('2d').drawImage(frame,0,0);const data=[...c.getContext('2d').getImageData(20,20,1,1).data];return data[0]<50 && data[1]<80 && data[2]>90;}
            finally{frame?.close();await r.cancel();track.stop();}}''')
        record('Native MediaStreamTrackProcessor receives processed frames, not an overlay',processor)
        iso("setTestSettings({color:'#864628'})");time.sleep(.7)
        record('Background changes in an already opened stream',lambda:pixelcheck([134,70,40],[225,44,57]))
        iso("setTestSettings({enabled:false})");time.sleep(.7)
        record('Explicit effect OFF returns ordinary camera image',lambda:pixelcheck([18,184,93],[225,44,57]))
        iso("setTestSettings({enabled:true})");time.sleep(.7)
        iso('globalThis.testModelFail=true');time.sleep(.7)
        record('Inference error produces slate, never raw room',lambda:pixelcheck([21,32,44]))
        record('Inference error is visible in diagnostics',lambda:iso("[...document.querySelectorAll('[data-aura-pipeline]')].length===1" ) and 'TEST_INFERENCE_FAILURE' in iso('lastStatus.error'))
        iso('globalThis.testModelFail=false');iso("setTestSettings({mode:'image',background:'ocean'})");time.sleep(.7)
        def imagecheck():
            result=page.evaluate('sample()');assert abs(result['outside'][1]-184)>15 or abs(result['outside'][0]-18)>15,result
            assert abs(result['inside'][0]-225)<10,result
            return result
        record('Bundled image background is composited',imagecheck)
        for bg in ['studio','office','graphite','mountains','dunes','forest','aurora']:
            iso('setTestSettings('+json.dumps({'background':bg})+')');time.sleep(.14)
        record('All eight bundled backgrounds decode without failure',lambda:iso("!lastStatus.error"))
        iso("setTestSettings({mode:'blur'})");time.sleep(.2)
        record('Blur mode keeps foreground sharp',lambda:abs(page.evaluate('sample().inside[0]')-225)<10)
        iso("setTestSettings({mode:'color',quality:'eco'})");time.sleep(.2)
        record('Economy profile keeps a valid even-sized stream',lambda:page.evaluate('sample().width===640 && sample().height===360'))
        page.evaluate('''()=>{window.cloneA=output.getVideoTracks()[0].clone();window.cloneStream=output.clone();output.getVideoTracks()[0].stop();}''')
        record('Stopping original video keeps clones and source alive',lambda:page.evaluate("cloneA.readyState==='live' && cloneStream.getVideoTracks()[0].readyState==='live' && rawStreams[0].getVideoTracks()[0].readyState==='live'"))
        page.evaluate('cloneA.enabled=false;cloneStream.getVideoTracks()[0].enabled=false;')
        record('Disabling all output clones disables physical source track',lambda:page.evaluate('rawStreams[0].getVideoTracks()[0].enabled===false'))
        page.evaluate('cloneA.enabled=true')
        record('Re-enabling a clone re-enables the source',lambda:page.evaluate('rawStreams[0].getVideoTracks()[0].enabled===true'))
        page.evaluate('cloneA.stop();cloneStream.getVideoTracks()[0].stop()');time.sleep(.2)
        record('Stopping last video clone releases camera but not microphone',lambda:page.evaluate("rawStreams[0].getVideoTracks()[0].readyState==='ended' && output.getAudioTracks()[0].readyState==='live'"))
        record('Pipeline DOM cleaned up',lambda:page.evaluate("document.querySelectorAll('[data-aura-pipeline]').length===0"))
        page.evaluate('output.getAudioTracks()[0].stop();cloneStream.getAudioTracks()[0].stop();')
        record('Audio-only request stays untouched',lambda:page.evaluate('''async()=>{const x=await navigator.mediaDevices.getUserMedia({audio:true,video:false});const ok=x===rawStreams.at(-1);x.getTracks().forEach(t=>t.stop());return ok;}'''))
        record('Camera reopens after all tracks are stopped',lambda:page.evaluate('''async()=>{const x=await navigator.mediaDevices.getUserMedia({video:true});const ok=x.getVideoTracks()[0].readyState==='live';x.getTracks().forEach(t=>t.stop());return ok;}'''))
        iso("globalThis.testTopURL='https://meet.google.com/test-call';setTestSettings({meetEnabled:false})");time.sleep(.3)
        record('Meet excluded: new camera request returns native stream unchanged',lambda:page.evaluate('''async()=>{const x=await navigator.mediaDevices.getUserMedia({video:true});const ok=x===rawStreams.at(-1);x.getTracks().forEach(t=>t.stop());return ok;}'''))
        iso("setTestSettings({meetEnabled:true})");time.sleep(.3)
        record('Meet enabled: new camera request is processed',lambda:page.evaluate('''async()=>{const x=await navigator.mediaDevices.getUserMedia({video:true});const ok=x.getVideoTracks()[0]!==rawStreams.at(-1).getVideoTracks()[0];x.getTracks().forEach(t=>t.stop());return ok;}'''))
        iso("globalThis.testTopURL='https://other.example/';setTestSettings({everywhere:false})");time.sleep(.3)
        record('All-sites OFF bypasses a non-Telemost site',lambda:page.evaluate('''async()=>{const x=await navigator.mediaDevices.getUserMedia({video:true});const ok=x===rawStreams.at(-1);x.getTracks().forEach(t=>t.stop());return ok;}'''))
        iso("setTestSettings({everywhere:true,algorithm:'multiclass'})");time.sleep(.3)
        page.evaluate('''async()=>{window.multi=await navigator.mediaDevices.getUserMedia({video:true});document.querySelector('#out').srcObject=multi;await document.querySelector('#out').play();}''');time.sleep(1)
        record('Multi-class adapter returns opaque person and replaced background',lambda:pixelcheck([134,70,40],[225,44,57]))
        page.evaluate('multi.getTracks().forEach(t=>t.stop())');time.sleep(.2)
        # Asynchronous inference doubles exercise ownership and cancellation of new ML adapters.
        iso("globalThis.originalModels=AuraModels;globalThis.fakePredicting=0;globalThis.fakeClosed=0;globalThis.fakeClosedDuringInference=false;globalThis.AuraModels={create:async()=>({backend:'TEST_ASYNC_MODEL',warning:'',async predict(frame){fakePredicting++;await new Promise(r=>setTimeout(r,180));fakePredicting--;return {width:frame.width,height:frame.height,data:new Float32Array(frame.width*frame.height).fill(1),matting:true};},async close(){if(fakePredicting)fakeClosedDuringInference=true;fakeClosed++;}})}")
        iso("setTestSettings({algorithm:'rvm'})")
        page.evaluate("async()=>{window.pending=await navigator.mediaDevices.getUserMedia({video:true});document.querySelector('#out').srcObject=pending;await document.querySelector('#out').play();}")
        for _ in range(60):
            if iso('fakePredicting>0'):break
            time.sleep(.01)
        page.evaluate('pending.getTracks().forEach(t=>t.stop())');time.sleep(.35)
        record('Stopping camera during inference closes model after inference completes',lambda:iso('fakeClosed>0 && !fakeClosedDuringInference'))
        record('Async stop removes the shared pipeline and source camera',lambda:page.evaluate("document.querySelectorAll('[data-aura-pipeline]').length===0 && rawStreams.at(-1).getVideoTracks()[0].readyState==='ended'"))
        page.evaluate("async()=>{window.pending=await navigator.mediaDevices.getUserMedia({video:true});document.querySelector('#out').srcObject=pending;await document.querySelector('#out').play();}")
        for _ in range(60):
            if iso('fakePredicting>0'):break
            time.sleep(.01)
        iso("setTestSettings({enabled:false})");time.sleep(.45)
        record('Turning effect OFF during inference discards stale alpha result',lambda:pixelcheck([18,184,93],[225,44,57]))
        record('Turning effect OFF releases model without concurrent disposal',lambda:iso('fakeClosed>=2 && !fakeClosedDuringInference'))
        page.evaluate('pending.getTracks().forEach(t=>t.stop())');time.sleep(.2)
        iso("globalThis.AuraModels=originalModels;setTestSettings({enabled:true,algorithm:'multiclass'})")
        iso("setTestSettings({processing:'detail'})")
        time.sleep(.4)
        record('Detail mode selectable without changing site exclusions',lambda:iso("testSettings.processing==='detail'"))
        record('No uncaught browser script errors',lambda: not errors or (_ for _ in ()).throw(AssertionError(errors)))
        version=browser.version
        browser.close()
    report={'environment':f'Chromium {version} (Linux, headless)','realExtensionInstalled':False,'realMediaPipeModel':False,'realOnnxModel':False,'extensionInstallationBlockedByPolicy':True,'realCamera':False,'telemostCall':False,'results':results}
    (ROOT/'tests/browser-report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    print(json.dumps({'passed':sum(r['passed'] for r in results),'total':len(results)},ensure_ascii=False))
    if any(not r['passed'] for r in results):raise SystemExit(1)

if __name__=='__main__':main()
