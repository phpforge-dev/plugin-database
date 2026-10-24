import {webkit} from '@playwright/test';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{if(req.url==='/workbench.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile('workbench.js'));}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="db"></div><div class="code"><div id="editor"></div></div>');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await webkit.launch({headless:true});
try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto('http://127.0.0.1:'+server.address().port);
 const result=await page.evaluate(async()=>{
  const {activate}=await import('/workbench.js');const disposers=[];let providers=0,listeners=0,reset=false;const own=value=>{disposers.push(typeof value==='function'?value:()=>value?.dispose?.());return value;};const disposable=kind=>{if(kind==='provider')providers++;else listeners++;return{dispose:()=>{if(kind==='provider')providers--;else listeners--;}}};
  let resolveSources;const api={databaseSources:()=>new Promise(r=>resolveSources=r),databaseDisconnect:async()=>{},databaseCancel:async()=>{}};
  const editor={createContextKey:()=>({set(){},reset(){reset=true;}}),onDidChangeModel:()=>disposable('listener'),onDidChangeCursorPosition:()=>disposable('listener'),onDidChangeModelContent:()=>disposable('listener'),onKeyDown:()=>disposable('listener'),addCommand(){},getModel:()=>null};
  const monaco={languages:{CompletionItemKind:{Field:1,Struct:2,Module:3,Keyword:4,Snippet:5},registerCompletionItemProvider:()=>disposable('provider')},KeyMod:{CtrlCmd:1},KeyCode:{Enter:2,Escape:3}};
  const html=(s,...v)=>typeof s==='string'?s:s.reduce((a,x,i)=>a+x+(v[i]??''),'');let contribution;activate({api,monaco,own,tr:s=>s,msg:html,html,toolIcon(){},provide:(_name,value)=>contribution=value});
  const hooks={openConsole(){},disconnected(){},path:()=>undefined,status(){},virtual(){},open:async()=>{}};
  contribution.mountDatabase({databaseSources:()=>{throw Error('Unbrokered API used');}},hooks);contribution.sqlConsole({},editor,hooks);
  document.getElementById('db-add').click();const mounted=document.querySelectorAll('dialog').length===3&&document.querySelector('.datasources-dialog').open&&!!document.getElementById('sql-toolbar')&&providers===1&&listeners===4;
  disposers.reverse().forEach(f=>f());document.getElementById('db').textContent='new generation';resolveSources([]);await new Promise(r=>setTimeout(r,80));
  return{mounted,providers,listeners,reset,dialogs:document.querySelectorAll('dialog').length,toolbar:!!document.getElementById('sql-toolbar'),panels:!!document.getElementById('data-panel')||!!document.getElementById('sql-results'),preserved:document.getElementById('db').textContent==='new generation',catalog:contribution.sqlIntelligence.entries.size};
 });assert.deepEqual(result,{mounted:true,providers:0,listeners:0,reset:true,dialogs:0,toolbar:false,panels:false,preserved:true,catalog:0});assert.deepEqual(errors,[]);console.log('Database plugin browser lifecycle passed:',result);
}finally{await browser.close();server.close();}
