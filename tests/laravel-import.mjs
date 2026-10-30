// "Import from Laravel .env…" in WebKit (the macOS Tauri WebView) with the built bundle and stylesheet.
import {webkit} from '@playwright/test';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{if(req.url==='/workbench.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile('workbench.js'));}else if(req.url==='/workbench.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('workbench.css'));}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/workbench.css"><div id="db"></div><div class="code"></div>');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await webkit.launch({headless:true});
try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(async()=>{
  // Tauri's WebView silently returns false/empty from native dialogs; the flow must never depend on them.
  window.nativeDialogs=[];for(const name of ['alert','confirm','prompt'])window[name]=()=>{window.nativeDialogs.push(name);return name==='prompt'?null:false;};
  const {activate}=await import('/workbench.js');const html=(s,...v)=>typeof s==='string'?s:s.reduce((a,x,i)=>a+x+(v[i]??''),'');let contribution;
  window.envFiles=['.env','.env.testing'];window.calls=[];
  const api={databaseSources:async()=>[],databaseDisconnect:async()=>{},databaseCancel:async()=>{},databasePasswordStored:async()=>false,
   databaseLaravelFiles:async()=>{window.calls.push('files');if(window.envFiles instanceof Error)throw window.envFiles;return window.envFiles;},
   databaseImportLaravel:async file=>{window.calls.push('import:'+file);if(file==='.env.testing')throw 'DB_CONNECTION "mongodb" não suportado na importação. Configure o driver manualmente.';return {driver:'postgres',host:'db',port:5432,database:'app',user:'sail',password:'fixture-secret',file:'',warnings:['O host pode ser um serviço Docker/Sail.']};}};
  const monaco={languages:{CompletionItemKind:{Field:1,Struct:2,Module:3,Keyword:4,Snippet:5},registerCompletionItemProvider:()=>({dispose(){}})},KeyMod:{CtrlCmd:1},KeyCode:{Enter:2,Escape:3}};
  activate({api,monaco,own(){},tr:s=>s,msg:html,html,toolIcon(){},provide:(_name,value)=>contribution=value});
  contribution.mountDatabase(api,{openConsole(){},disconnected(){}});
 });
 const visible=selector=>page.evaluate(s=>{const e=document.querySelector(s);return !!e&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0;},selector);
 const status=()=>page.locator('#ds-import-status').textContent();

 // The picker must stay hidden until the .env files are listed: an empty "Importar conexão" did nothing.
 await page.locator('#db-empty-add').click();
 assert.equal(await visible('#ds-import-picker'),false,'env picker visible before listing .env files');
 await page.locator('#db-dialog-close').click();

 // Empty state → lists files → imports into a new, unsaved draft with the password only in the form.
 await page.locator('#db-empty-import').click();await page.waitForFunction(()=>document.querySelectorAll('#ds-env-file option').length===2);
 assert.equal(await visible('#ds-import-picker'),true,'env picker hidden after listing');assert.equal(await visible('#ds-driver-menu'),false,'driver menu covers the import picker');
 await page.locator('#ds-import-read').click();await page.waitForFunction(()=>document.querySelector('#connection-form [name=database]').value==='app');
 const form=await page.evaluate(()=>{const f=n=>document.querySelector(`#connection-form [name=${n}]`);return {driver:f('driver').value,host:f('host').value,port:f('port').value,user:f('user').value,password:f('password').value,type:f('password').type,text:document.querySelector('.datasources-dialog').innerText};});
 assert.deepEqual({...form,text:undefined},{driver:'postgres',host:'db',port:'5432',user:'sail',password:'fixture-secret',type:'password',text:undefined});
 assert.ok(!form.text.includes('fixture-secret'),'password rendered as text');
 assert.equal(await visible('#ds-import-picker'),false,'picker kept open after import');assert.match(await status(),/importada/);

 // Unsupported driver: clear message, draft untouched, picker stays available to choose another file.
 await page.locator('#ds-import-env').click();await page.waitForFunction(()=>document.querySelectorAll('#ds-env-file option').length===2);
 await page.locator('#ds-env-file').selectOption('.env.testing');await page.locator('#ds-import-read').click();await page.waitForFunction(()=>/não suportado/.test(document.getElementById('ds-import-status').textContent));
 assert.equal(await page.locator('#connection-form [name=database]').inputValue(),'app','failed import changed the draft');assert.equal(await visible('#ds-import-picker'),true,'picker hidden after recoverable error');

 // Missing .env and non-Laravel projects: message shown, no picker, retry works.
 await page.evaluate(()=>{window.envFiles=[];});await page.locator('#ds-import-env').click();await page.waitForFunction(()=>/Nenhum arquivo .env/.test(document.getElementById('ds-import-status').textContent));
 assert.equal(await visible('#ds-import-picker'),false,'empty picker shown without .env');
 await page.evaluate(()=>{window.envFiles=new Error('Importação disponível em projetos Laravel (laravel/framework no composer.json).');});await page.locator('#ds-import-env').click();await page.waitForFunction(()=>/projetos Laravel/.test(document.getElementById('ds-import-status').textContent));
 assert.ok(!(await status()).startsWith('Error:'),'raw Error prefix in status');assert.equal(await visible('#ds-import-picker'),false,'picker shown after listing failed');

 // Cancel discards the imported draft and its password.
 await page.locator('#db-cancel').click();assert.equal(await page.locator('#connection-form [name=password]').inputValue(),'');
 assert.deepEqual(await page.evaluate(()=>window.nativeDialogs),[]);assert.deepEqual(errors,[]);
 console.log('Database plugin Laravel .env import passed:',await page.evaluate(()=>window.calls));
}finally{await browser.close();server.close();}
