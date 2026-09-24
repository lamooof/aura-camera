'use strict';
// Mocked extension APIs: this is not evidence that Chrome actually injected scripts.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),results=[],calls=[],badges=[];
let listener,removed,updated,failInjection=false;
const c={console,Date,Map,Number,Object,importScripts(){},chrome:{
 runtime:{id:'aura-test',onMessage:{addListener:f=>listener=f}},
 scripting:{async executeScript(args){calls.push(args);if(failInjection)throw new Error('INJECTION_DENIED');return []; }},
 tabs:{sendMessage:async()=>{},onRemoved:{addListener:f=>removed=f},onUpdated:{addListener:f=>updated=f}},
 action:{setBadgeText:async o=>badges.push(o),setBadgeBackgroundColor:async()=>{}}
}};
vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'extension/service-worker.js'),'utf8'),c);
const sender={id:'aura-test',tab:{id:10,url:'https://meet.google.com/abc'},frameId:2,documentId:'docA',url:'https://embedded.example/'};
function send(m,s=sender){return new Promise(resolve=>{const pending=listener(m,s,resolve);if(pending!==true)queueMicrotask(()=>resolve(undefined));});}
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:e.stack});console.log('FAIL',name,e.message);}}
(async()=>{
 await test('Messages from a different extension are ignored',async()=>{const r=await send({type:'aura-policy'},{...sender,id:'other'});assert.equal(r,undefined);});
 await test('Meet policy uses Chrome sender metadata, not request URL',async()=>{const r=await send({type:'aura-policy',topURL:'https://evil.test'});assert.equal(r.topURL,sender.tab.url);assert.equal(r.frameURL,sender.url);});
 await test('Lazy MediaPipe injected into the requesting document in ISOLATED world',async()=>{const r=await send({type:'aura-load-library',library:'mp'});assert(r.ok);const q=calls.at(-1);assert.equal(q.world,'ISOLATED');assert.equal(q.target.documentIds[0],'docA');assert.equal(q.target.tabId,10);assert.equal(q.files.length,2);});
 await test('Repeated library requests are deduplicated per document',async()=>{const n=calls.length;await Promise.all([send({type:'aura-load-library',library:'mp'}),send({type:'aura-load-library',library:'mp'})]);assert.equal(calls.length,n);});
 await test('Different document IDs receive their own libraries',async()=>{const n=calls.length;await send({type:'aura-load-library',library:'mp'},{...sender,documentId:'docB'});assert.equal(calls.length,n+1);});
 await test('Library whitelist rejects paths and prototype keys',async()=>{const n=calls.length;for(const library of ['__proto__','constructor','https://evil.test/code.js','../main.js']){const r=await send({type:'aura-load-library',library});assert.equal(r.ok,false);}assert.equal(calls.length,n);});
 await test('Libraries cannot be injected without a calling tab',async()=>{assert.equal((await send({type:'aura-load-library',library:'ort'},{id:'aura-test'})).ok,false);});
 await test('Injection denial is reported and can be retried',async()=>{failInjection=true;assert.equal((await send({type:'aura-load-library',library:'ort'})).ok,false);failInjection=false;assert.equal((await send({type:'aura-load-library',library:'ort'})).ok,true);});
 await test('Navigation clears the per-document library cache',async()=>{updated(10,{status:'loading'});const n=calls.length;await send({type:'aura-load-library',library:'mp'});assert.equal(calls.length,n+1);});
 await test('Active camera status produces an ON badge',async()=>{await send({type:'aura-engine-status',status:{active:1,processingEnabled:true,hookReady:true,error:'',frames:5}});assert.equal(badges.at(-1).text,'ON');const r=await send({type:'aura-query',tabId:10});assert.equal(r.frames,5);});
 await test('Processing failure remains visible in diagnostics',async()=>{await send({type:'aura-engine-status',status:{active:1,processingEnabled:true,hookReady:true,error:'MODEL_FAILURE'}});assert.equal(badges.at(-1).text,'!');assert.equal((await send({type:'aura-query',tabId:10})).error,'MODEL_FAILURE');});
 await test('Closing a tab clears status',async()=>{removed(10);assert.equal((await send({type:'aura-query',tabId:10})).missing,true);});
 fs.writeFileSync(path.join(__dirname,'worker-report.json'),JSON.stringify({realChromeAPI:false,results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
})();
