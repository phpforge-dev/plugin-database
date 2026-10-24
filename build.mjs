import {build} from 'esbuild';
import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
const worker=await build({entryPoints:['src/sql-intelligence.worker.ts'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await writeFile('src/worker-source.ts','export default '+JSON.stringify(worker.outputFiles[0].text)+';\n');
const result=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'eof',loader:{'.css':'empty'},plugins:[{name:'owned-ui-disposables',setup(build){build.onLoad({filter:/(sql-console|database-panel)\.ts$/},async({path})=>{
let text=await readFile(path,'utf8');const sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);const edits=[];
function walk(node){if(ts.isCallExpression(node)){const callee=node.expression.getText(sf);if(/^(editor\.onDid|editor\.onKeyDown|monaco\.languages\.register)/.test(callee)){edits.push([node.getStart(sf),'sdk.own('],[node.end,')']);}}ts.forEachChild(node,walk);}walk(sf);for(const[at,value]of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,at)+value+text.slice(at);return{contents:text,loader:'ts'};});}}]});
await writeFile('workbench.js','export function activate(sdk){\n'+result.outputFiles[0].text+'\n}\n');
await writeFile('workbench.css',(await readFile('src/database-connection.css','utf8'))+'\n'+await readFile('src/sql-intelligence.css','utf8')+'\n'+await readFile('src/workbench-host.css','utf8'));
