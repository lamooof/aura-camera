"""UI tests in Chromium with mocked Chrome storage/runtime. No extension or ML installed."""
from pathlib import Path
import json, base64, re, shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EXT=ROOT/'extension'
results=[]
def record(name,fn):
    try:
        value=fn()
        if value is False: raise AssertionError('false')
        results.append({'name':name,'passed':True}); print('PASS',name)
    except Exception as e:
        results.append({'name':name,'passed':False,'error':str(e)});print('FAIL',name,str(e)[:240])

def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        errors=[]
        assets={f'backgrounds/{f.name}':'data:image/jpeg;base64,'+base64.b64encode(f.read_bytes()).decode() for f in (EXT/'backgrounds').glob('*.jpg')}
        def create_page(view):
            page=browser.new_page(viewport={'width':396 if view=='popup' else 1320,'height':1000},accept_downloads=True)
            page.on('pageerror',lambda e: errors.append(str(e)))
            html=(EXT/(view+'.html')).read_text()
            html=re.sub(r'<script.*?</script>','',html,flags=re.S)
            html=html.replace('<link rel="stylesheet" href="ui.css">','<style>'+(EXT/'ui.css').read_text()+'</style>')
            html=html.replace('src="icons/48.png"','src="data:image/png;base64,'+base64.b64encode((EXT/'icons/48.png').read_bytes()).decode()+'"')
            page.set_content(html)
            page.evaluate("""assets=>{
              window._saved={settings:{background:'office',quality:'ultra'}};
              const listeners=[];
              window.chrome={runtime:{id:'ui-test',getURL:p=>assets[p]||p,sendMessage:async m=>({hookReady:true,siteAllowed:true,active:0}),openOptionsPage:async()=>{window.openedOptions=true;}},
                tabs:{query:async()=>[{id:1}],sendMessage:async()=>({ok:true})},
                storage:{local:{get:async()=>structuredClone(_saved),set:async obj=>{Object.assign(_saved,obj);for(const f of listeners)f({settings:{newValue:obj.settings}},'local');}},onChanged:{addListener:f=>listeners.push(f)}}};
              globalThis.AuraBuild={prepared:true,version:'0.4.0',installed:{fast:true,multiclass:true,rvm:true,modnet:true,depth:true}};
              globalThis.AuraPreviewEngine={snapshot:()=>({hookReady:true,siteAllowed:true,active:0}),retry(){}};
            }""", assets)
            page.add_script_tag(content=(EXT/'core.js').read_text())
            page.add_script_tag(content=(EXT/'ui.js').read_text())
            page.wait_for_selector('#gallery button');page.wait_for_timeout(80)
            return page
        page=create_page('popup')
        record('All five algorithms available after preparation',lambda:page.locator('#algorithm option').count()==5)
        record('Google Meet excluded by default',lambda:not page.locator('#meetEnabled').is_checked())
        record('All ordinary sites enabled by default',lambda:page.locator('#everywhere').is_checked())
        record('Existing background and quality preserved',lambda:page.locator('#quality').input_value()=='ultra' and page.locator('#gallery button[aria-pressed=true]').get_attribute('title')=='Кабинет')
        page.locator('#meetEnabled').check();page.wait_for_timeout(70)
        record('Meet switch saved separately',lambda:page.evaluate('_saved.settings.meetEnabled===true && _saved.settings.everywhere===true'))
        page.locator('#everywhere').uncheck();page.wait_for_timeout(70)
        record('All-sites switch does not overwrite Meet choice',lambda:page.evaluate('_saved.settings.everywhere===false && _saved.settings.meetEnabled===true'))
        record('Scope change explains page refresh',lambda:'обновите' in page.locator('#notice').inner_text())
        for key in ['fast','multiclass','rvm','modnet','depth']:
            page.select_option('#algorithm',key);page.wait_for_timeout(50)
            record('Algorithm '+key+' saved',lambda key=key:page.evaluate('_saved.settings.algorithm')==key)
        page.locator('summary').click()
        record('Depth parameters shown only for depth mode',lambda:page.locator('#depthOptions').is_visible())
        page.select_option('#algorithm','rvm');page.wait_for_timeout(50)
        record('Depth parameters hidden in RVM',lambda:not page.locator('#depthOptions').is_visible())
        page.select_option('#accelerator','cpu');page.wait_for_timeout(50)
        record('CPU override persists',lambda:page.evaluate('_saved.settings.accelerator')=='cpu')
        page.locator('[data-mode=color]').click();page.wait_for_timeout(50)
        record('Color mode works',lambda:page.locator('#colorOptions').is_visible() and not page.locator('#imageOptions').is_visible())
        page.locator('[data-mode=blur]').click();page.wait_for_timeout(50)
        record('Blur mode works',lambda:page.locator('#blurOptions').is_visible())
        page.locator('[data-mode=image]').click();page.wait_for_timeout(50)
        record('All eight backgrounds shown',lambda:page.locator('#gallery button').count()==8)
        for key,value in [('edge','6'),('temporal','35'),('feather','0.8')]:
            page.locator('#'+key).fill(value);page.locator('#'+key).dispatch_event('change');page.wait_for_timeout(50)
        record('Refinement controls persist their numeric units',lambda:page.evaluate('_saved.settings.edge===6 && _saved.settings.temporal===0.35 && _saved.settings.feather===0.8'))
        page.select_option('#processing','detail');page.wait_for_timeout(50)
        record('Full detail processing mode persists',lambda:page.evaluate("_saved.settings.processing==='detail'"))
        page.locator('#speedPreset').click();page.wait_for_timeout(80)
        record('Speed button selects fast/balanced/efficient/auto',lambda:page.evaluate("_saved.settings.algorithm==='fast' && _saved.settings.quality==='balanced' && _saved.settings.processing==='efficient' && _saved.settings.accelerator==='auto'"))
        record('Speed button preserves separate site choices',lambda:page.evaluate("_saved.settings.meetEnabled===true && _saved.settings.everywhere===false"))
        record('Antiflicker remains opt-in after migration',lambda:not page.locator('#antiflicker').is_checked())
        previous=page.evaluate('structuredClone(_saved.settings)')
        page.locator('#antiflickerPreset').click();page.wait_for_timeout(80)
        record('Antiflicker button enables guard at 40 percent',lambda:page.evaluate('_saved.settings.antiflicker===true && _saved.settings.temporal===0.4'))
        record('Antiflicker button leaves all other settings intact',lambda:all(page.evaluate('_saved.settings')[k]==v for k,v in previous.items() if k not in ('antiflicker','temporal')))
        page.locator('#antiflicker').uncheck();page.wait_for_timeout(60)
        record('Guard toggle returns to legacy temporal mode',lambda:page.evaluate('_saved.settings.antiflicker===false'))
        record('Popup has no horizontal overflow',lambda:page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'))
        with page.expect_download() as d:page.locator('#exportDiagnostic').click()
        record('Diagnostic report downloads without frames',lambda:'diagnostic' in d.value.suggested_filename)
        page.locator('#openPreview').click()
        record('Preview opens only after explicit button',lambda:page.evaluate('window.openedOptions===true'))
        # Default visual state, no webcam or synthesized inference result in screenshot.
        page.close();page=create_page('preview')
        record('Preview has the same five-model selector',lambda:page.locator('#algorithm option').count()==5)
        record('Preview contains all four quality choices',lambda:page.locator('#quality option').count()==4)
        record('Preview contains matching antiflicker controls',lambda:page.locator('#antiflicker').count()==1 and page.locator('#antiflickerPreset').count()==1)
        record('Preview does not open camera on load',lambda:page.evaluate('document.querySelector("#cameraOutput").srcObject===null'))
        record('Model self-test control is present',lambda:page.locator('#testModels').is_visible())
        record('No uncaught UI errors',lambda:not errors)
        page.screenshot(path=str(ROOT/'INTERFACE.png'),full_page=True)
        browser.close()
    (ROOT/'tests/ui-report.json').write_text(json.dumps({'realChromeAPI':False,'realModels':False,'results':results},ensure_ascii=False,indent=2))
    if any(not r['passed'] for r in results):raise SystemExit(1)
if __name__=='__main__':main()
