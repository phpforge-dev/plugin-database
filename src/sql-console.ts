import './sql-intelligence.css';
import { t as tr, msg, html } from './i18n';
import * as monaco from './monaco';
import type { DatabaseSession, IdeApi, SqlResult } from '../shared/contracts';
import { driverInfo } from '../shared/datasource';
import { statementAt, type SqlItem } from '../shared/sql';
import { sqlIntelligence } from './sql-intelligence';
import { sqlRegion } from '../shared/sql-intelligence/embedded';

type Hooks = {
 virtual(path: string, text: string, language: string, kind: 'console', uri: monaco.Uri): monaco.editor.ITextModel;
 open(path: string): Promise<void>;
 status(message: string): void;
 path(): string | undefined;
};
const kinds: Record<SqlItem['kind'], monaco.languages.CompletionItemKind> = {
 column: monaco.languages.CompletionItemKind.Field, table: monaco.languages.CompletionItemKind.Struct, view: monaco.languages.CompletionItemKind.Struct,
 schema: monaco.languages.CompletionItemKind.Module, keyword: monaco.languages.CompletionItemKind.Keyword, columns: monaco.languages.CompletionItemKind.Snippet,
};

/** Console SQL como aba do editor (Executar ⌘/Ctrl+Enter, auto-commit) e resultados no painel inferior. */
export function sqlConsole(api: IdeApi, editor: monaco.editor.IStandaloneCodeEditor, hooks: Hooks) {
 let disposed=false;
 const consoles = new Map<string, DatabaseSession>();
 const toolbar = document.createElement('div'); toolbar.id = 'sql-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', tr('Console SQL')); toolbar.hidden = true;
 toolbar.innerHTML = html('<button id="sql-execute" title="Executar comando sob o cursor ou seleção (⌘/Ctrl+Enter)">▶ Executar</button><span class="sql-tx" title="Cada comando é confirmado automaticamente">Tx: Auto</span><button id="sql-cancel" disabled>Cancelar</button><label id="sql-connection-label">Conexão SQL <select id="sql-connection"><option value="">Escolher conexão…</option></select></label><label>Schema das sugestões <select id="sql-schema"></select></label><span id="sql-source" role="status" aria-live="polite"></span><button id="sql-metadata-refresh" title="Atualizar metadados SQL">↻</button><button id="sql-scope" title="Preparar apenas o schema selecionado">Somente este schema</button><details class="sql-options"><summary>Opções SQL</summary><label>Atualização automática<select id="sql-refresh-interval"><option value="15000">15 segundos</option><option value="60000" selected>60 segundos</option><option value="300000">5 minutos</option></select></label></details>');
 const results = document.createElement('section'); results.id = 'sql-results'; results.hidden = true;
 results.innerHTML = html('<div class="data-toolbar"><strong id="sql-results-title">Resultados</strong><span id="sql-tabs" role="tablist"></span><span id="sql-summary" role="status"></span><button id="sql-results-close" aria-label="Fechar resultados">×</button></div><div id="sql-grid" tabindex="0" aria-label="Resultado da consulta"></div>');
 const code = document.querySelector('.code')!;
 // The host may wrap #editor (preview split): anchor on whichever child of .code holds it.
 const editorNode = document.getElementById('editor'); code.insertBefore(toolbar, [...code.children].find(child => editorNode && child.contains(editorNode)) ?? null); code.append(results);
 const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
 const isConsole = editor.createContextKey<boolean>('sqlConsole', false);
 let running: string | undefined;

 const current = () => { const model = editor.getModel(); return model ? consoles.get(model.uri.toString()) : undefined; };
 const activeEntry = () => { const session = current(); return session ? sqlIntelligence.entries.get(session.id) : sqlIntelligence.selected(hooks.path() ?? ''); };
 const chosenSchemas = new Map<string,string>();
 let toolbarStamp = '';
 async function refreshToolbar() {
  if(disposed)return;
  const session = current(), model = editor.getModel(); const embedded = !!model && /php$/.test(hooks.path() ?? '');
  toolbar.hidden = !session && !embedded && !/\.sql$/i.test(hooks.path()??''); isConsole.set(!!session);
  $('sql-execute').hidden = !session; $('sql-cancel').hidden = !session; toolbar.querySelector<HTMLElement>('.sql-tx')!.hidden = !session;
  $('sql-connection-label').hidden = !!session;
  const entry = activeEntry();
  $<HTMLButtonElement>('sql-execute').disabled=!!running||!entry;
  $('sql-scope').textContent=entry?.schemas.length?tr('Todos os schemas'):tr('Somente este schema');
  const conn = $<HTMLSelectElement>('sql-connection');
  const stamp = [...sqlIntelligence.entries.keys()].join(',') + ':' + (entry?.session.id ?? '');
  if(stamp!==toolbarStamp){toolbarStamp=stamp;conn.replaceChildren(new Option(tr('Escolher conexão…'),''),...([...sqlIntelligence.entries.values()].map(e=>new Option(e.session.label,e.session.id))));conn.value=entry?.session.id??'';}
  const region = embedded && model ? sqlRegion(model.getValue(),model.getOffsetAt(editor.getPosition()!),(hooks.path()??'').endsWith('.blade.php')) : null;
  $('sql-source').textContent = region?.unsafe ?? (entry ? `${entry.session.label} · ${tr(({Preparing:'Preparando SQL…',Ready:'SQL pronto',Partial:'SQL parcial',Refreshing:'Atualizando SQL…',Unavailable:'SQL indisponível'} as const)[entry.state])} · ${entry.relations} ${tr('tabelas')} · ${entry.columns} ${tr('colunas')}${entry.degraded?' · '+entry.degraded:''}${entry.errors.length?' · '+entry.errors[0].slice(0,100):''}` : tr('Escolha uma conexão para as sugestões SQL'));
  $('sql-source').title = entry?.errors.join('\n') ?? '';
  const select = $<HTMLSelectElement>('sql-schema');
  const schemas = entry?.model.schemas.map(s=>s.name) ?? [];
  const chosen=entry?(chosenSchemas.get(entry.session.id)??entry.model.defaultSchema):'';
  if([...select.options].map(o=>o.value).join(',')!==schemas.join(','))select.replaceChildren(...schemas.map(s=>new Option(s,s)));
  select.value=chosen;
 }
 $('sql-refresh-interval').onchange=()=>{sqlIntelligence.refreshInterval=Number($<HTMLSelectElement>('sql-refresh-interval').value);};
 $('sql-connection').onchange=()=>{
  editor.trigger('sql-binding','hideSuggestWidget',{});
  const path=hooks.path(),id=$<HTMLSelectElement>('sql-connection').value;
  if(path)sqlIntelligence.bind(path,id||undefined);editor.focus();
  const model=editor.getModel(),position=editor.getPosition();
  if(id&&model&&position&&(path?.endsWith('.sql')||sqlRegion(model.getValue(),model.getOffsetAt(position),path?.endsWith('.blade.php'))))editor.trigger('sql-binding','editor.action.triggerSuggest',{});
 };
 $('sql-schema').onchange=()=>{const e=activeEntry();if(e){chosenSchemas.set(e.session.id,$<HTMLSelectElement>('sql-schema').value);sqlIntelligence.setSchema(e.session.id,$<HTMLSelectElement>('sql-schema').value);}editor.focus();};
 $('sql-metadata-refresh').onclick=()=>{const e=activeEntry();if(e)void sqlIntelligence.refresh(e.session.id);};
 $('sql-scope').onclick=()=>{const e=activeEntry(),schema=$<HTMLSelectElement>('sql-schema').value;if(e&&schema)void sqlIntelligence.refresh(e.session.id,e.schemas.length?[]:[schema]);};
 let updateTimer:ReturnType<typeof setTimeout>|undefined;
 const intelligenceChanged=()=>{void refreshToolbar();clearTimeout(updateTimer);updateTimer=setTimeout(()=>{if(editor.hasTextFocus()&&document.querySelector('.suggest-widget.visible'))editor.trigger('sql-metadata','editor.action.triggerSuggest',{});},80);};
 sqlIntelligence.addEventListener('change',intelligenceChanged);
 editor.onDidChangeModel(() => void refreshToolbar());
 editor.onDidChangeCursorPosition(()=>{if(!current())void refreshToolbar();});
 // Do not depend on a language's Monarch token category to activate first-character SQL suggestions.
 let typingTimer:ReturnType<typeof setTimeout>|undefined;
 editor.onDidChangeModelContent(event=>{
  const value=event.changes[0]?.text??'';
  if(event.isFlush||event.isUndoing||event.isRedoing||event.changes.length!==1||[...value].length!==1||!/[\p{L}\p{N}_. ]$/u.test(value)||!current()&&!/\.sql$/i.test(hooks.path()??''))return;
  clearTimeout(typingTimer);typingTimer=setTimeout(()=>{if(editor.hasTextFocus()&&!document.querySelector('.suggest-widget.visible'))editor.trigger('sql-typing','editor.action.triggerSuggest',{});},15);
 });
 editor.onKeyDown(event=>{if(event.keyCode===monaco.KeyCode.Escape)clearTimeout(typingTimer);});

 function render(list: SqlResult[], selected = list.length - 1) {
  results.hidden = false;
  const tabs = $('sql-tabs'); tabs.replaceChildren();
  list.forEach((r, i) => {
   const tab = document.createElement('button'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(i === selected));
   tab.textContent = r.kind === 'error' ? msg`Erro ${i + 1}` : `Resultado ${i + 1}`; tab.title = r.statement; tab.onclick = () => render(list, i); tabs.append(tab);
  });
  const r = list[selected];
  $('sql-summary').textContent = r.kind === 'rows' ? `${r.rows!.length}${r.truncated ? '+' : ''} ${r.rows!.length === 1 ? tr('linha') : tr('linhas')} · ${r.ms} ms` : r.kind === 'update' ? `${r.affected} ${r.affected === 1 ? tr('linha afetada') : tr('linhas afetadas')} · ${r.ms} ms` : `${r.ms} ms`;
  const grid = $('sql-grid'); grid.replaceChildren();
  if (r.kind === 'error') { const p = document.createElement('pre'); p.className = 'sql-error'; p.textContent = r.error!; grid.append(p); return; }
  if (r.kind === 'update') { const p = document.createElement('p'); p.textContent = `${r.statement.split('\n')[0].slice(0, 120)} — ${r.affected} linha(s).`; grid.append(p); return; }
  const table = document.createElement('table'); const head = table.createTHead().insertRow();
  const corner = document.createElement('th'); corner.className = 'sql-row-number'; head.append(corner);
  for (const name of r.columns!) { const th = document.createElement('th'); th.textContent = name; head.append(th); }
  const body = table.createTBody();
  r.rows!.forEach((values, n) => {
   const row = body.insertRow(); const number = row.insertCell(); number.className = 'sql-row-number'; number.textContent = String(n + 1);
   for (const value of values) { const c = row.insertCell(); c.textContent = value === null ? '<null>' : value; if (value === null) c.className = 'null-value'; }
  });
  grid.append(table);
  if (r.truncated) { const note = document.createElement('p'); note.textContent = tr('Exibindo as primeiras 500 linhas.'); grid.append(note); }
 }

 async function execute() {
  if(disposed)return;
  const session = current(); const model = editor.getModel(); if (!session || !model || running) return;
  if(!sqlIntelligence.entries.has(session.id)){hooks.status(tr('Conexão indisponível; reconecte antes de executar SQL.'));return;}
  const selection = editor.getSelection();
  const sql = selection && !selection.isEmpty() ? model.getValueInRange(selection) : statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()!), session.driver === 'oracle' ? 'oracle' : undefined)?.text ?? '';
  if (!sql.trim()) { hooks.status(tr('Nada para executar no cursor.')); return; }
  running = session.id; $<HTMLButtonElement>('sql-execute').disabled = true; $<HTMLButtonElement>('sql-cancel').disabled = false;
  $('sql-results-title').textContent = `${session.label} · executando…`; results.hidden = false;
  try {
   const list = await api.databaseExecute(session.id, sql);if(disposed)return;
   $('sql-results-title').textContent = session.label; render(list);
   hooks.status(list.at(-1)?.kind === 'error' ? tr('Falha ao executar SQL') : `${list.length} comando(s) executado(s)`);
  } catch (error) { if(disposed)return;$('sql-results-title').textContent = session.label; render([{ statement: sql, ms: 0, kind: 'error', error: String(error) }]); }
  finally { if(disposed)return;running = undefined; $<HTMLButtonElement>('sql-execute').disabled = false; $<HTMLButtonElement>('sql-cancel').disabled = true; }
 }
 $('sql-execute').onclick = () => void execute();
 $('sql-cancel').onclick = () => { const session = current(); if (session) void api.databaseCancel(session.id).then(() => hooks.status(tr('Cancelamento solicitado.'))); };
 $('sql-results-close').onclick = () => { results.hidden = true; };
 sdk.own(editor.addAction({id:'phpforge.database.execute',label:tr('Executar SQL'),keybindings:[monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],precondition:'sqlConsole',run:()=>void execute()}));

 monaco.languages.registerCompletionItemProvider(['pgsql', 'mysql', 'sql'], {
  triggerCharacters: ['.', ' '],
  async provideCompletionItems(model, position, _context, token) {
   const session = consoles.get(model.uri.toString())??sqlIntelligence.selected(hooks.path()??'')?.session; if (!session) return { suggestions: [] };
   const version=model.getVersionId(), controller=new AbortController();const cancellation=token.onCancellationRequested(()=>controller.abort());
   const result = await sqlIntelligence.complete(session.id, model.getValue(), model.getOffsetAt(position),controller.signal);cancellation.dispose();
   if(!result||token.isCancellationRequested||model.isDisposed()||model.getVersionId()!==version||editor.getModel()!==model||!sqlIntelligence.entries.has(session.id))return {suggestions:[],incomplete:true};
   const start = model.getPositionAt(result.from);
   const end=model.getPositionAt(result.to);const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
   return { incomplete:result.incomplete,suggestions: result.items.map((i, n) => ({ label: { label: i.label, detail: i.detail, description: i.description }, kind: kinds[i.kind], insertText: i.insertText??i.label, range, sortText: String(n).padStart(5, '0'), filterText: i.label })) };
  },
 });

 sdk.own(()=>{disposed=true;clearTimeout(updateTimer);clearTimeout(typingTimer);sqlIntelligence.removeEventListener('change',intelligenceChanged);isConsole.reset();if(running)void api.databaseCancel(running).catch(()=>{});consoles.clear();chosenSchemas.clear();toolbar.remove();results.remove();});
 return {
  async open(session: DatabaseSession) {
   if(disposed)return;
   const path = `consoles/${session.label}/console`;
   const uri = monaco.Uri.from({ scheme: 'php-ide-console', path: `/${session.id}/console.sql` });
   const model = hooks.virtual(path, '', driverInfo(session.driver).language, 'console', uri);
   consoles.set(model.uri.toString(), session);
   await hooks.open(path); editor.focus(); void refreshToolbar();
  },
  forget(_sessionId: string) { void refreshToolbar(); },
  reset() { consoles.clear(); chosenSchemas.clear(); results.hidden = true; toolbar.hidden = true; },
 };
}
