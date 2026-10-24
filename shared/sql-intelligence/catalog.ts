import type { DatabaseSession } from '../contracts';
import type { SqlCompletion } from './resolve';
import type { SqlModel, SqlSchema } from '../sql';
export type CatalogState = 'Preparing' | 'Ready' | 'Partial' | 'Refreshing' | 'Unavailable';
type Entry = { session: DatabaseSession; model: SqlModel; state: CatalogState; revision: number; generation: number; relations: number; columns: number; bytes: number; errors: string[]; loading?: Promise<void>; schemas: string[]; lastRefresh: number; degraded?: string; dirty?:boolean; selectedSchema?:string };
type Call = (method: string, args: unknown[]) => Promise<any>;
export class SqlIntelligence extends EventTarget {
 constructor(private createWorker:()=>Worker,readonly limits={relations:50000,columns:500000,bytes:64*1024*1024}){super();}
 private worker?: Worker; private ready = false; private sequence = 0; private generation = 0;
 private prepared=new Set<string>();
 private pending = new Map<number, { finish(value: SqlCompletion | null): void; timer: ReturnType<typeof setTimeout>; id: string; revision: number }>();
 readonly entries = new Map<string, Entry>();
 readonly bindings = new Map<string, string>();
 projectDefault?: string;
 refreshInterval = 60000;
 metadataRequests = 0;
 private call?: Call;
 private refreshing?: ReturnType<typeof setInterval>;
 configure(call: Call) { this.call = call; }
 private changed() { this.dispatchEvent(new Event('change')); }
 private post(message: unknown) { this.worker?.postMessage(message); }
 private start() {
  if (this.worker) return;
  this.ready = false; this.worker = this.createWorker();
  this.worker.onmessage = event => {
   if (event.data.type === 'ready') { this.ready = true; return; }
   if (event.data.type === 'context-ready') { this.prepared.add(event.data.id);this.changed();return; }
   const p = this.pending.get(event.data.request); if (!p) return;
   clearTimeout(p.timer); this.pending.delete(event.data.request);
   const entry = this.entries.get(p.id);
   if (event.data.error && entry) { entry.degraded = event.data.error; this.changed(); }
   if(entry&&event.data.result&&entry.degraded!==event.data.result.degraded){entry.degraded=event.data.result.degraded;this.changed();}
   p.finish(entry?.revision === p.revision && event.data.revision === p.revision ? event.data.result : null);
  };
  this.worker.onerror = event => { event.preventDefault(); this.failWorker('SQL worker failed; retry completion or refresh'); };
 }
 private failWorker(reason: string) {
  this.worker?.terminate(); this.worker = undefined; this.ready = false;this.prepared.clear();
  for (const p of this.pending.values()) { clearTimeout(p.timer); p.finish(null); } this.pending.clear();
  for (const e of this.entries.values()) e.degraded = reason;
  this.changed();
 }
 private restoreWorker() {
  this.start();
  for (const [id, entry] of this.entries) this.post({ type: 'context', id, model: entry.model, dialect: entry.session.driver, revision: entry.revision });
 }
 connect(session: DatabaseSession) {
  if (session.driver === 'redis') return;
  this.start(); const generation = ++this.generation;
  const entry: Entry = { session, model: { label: session.label, database: '', defaultSchema: '', schemas: [], complete: false }, state: 'Preparing', revision: 0, generation, relations: 0, columns: 0, bytes: 0, errors: [], schemas: [], lastRefresh: 0 };
  this.entries.set(session.id, entry); this.changed(); void this.refresh(session.id);
  this.refreshing ??= setInterval(() => { for (const [id, e] of this.entries) if (Date.now() - e.lastRefresh >= this.refreshInterval) void this.refresh(id); }, 1000);
 }
 bind(path: string, id?: string) { for(const [n,p] of this.pending){clearTimeout(p.timer);this.pending.delete(n);p.finish(null);}if (id) this.bindings.set(path, id); else this.bindings.delete(path); this.changed(); }
 selected(path: string) { const id = this.bindings.get(path) ?? this.projectDefault; return id ? this.entries.get(id) : undefined; }
 setSchema(id: string, schema: string) { const e=this.entries.get(id);if(!e)return;e.selectedSchema=schema;e.model={...e.model,defaultSchema:schema,searchPath:[schema,...(e.model.searchPath??[]).filter(s=>s!==schema)]};e.revision++;this.post({type:'context',id,model:e.model,dialect:e.session.driver,revision:e.revision});this.changed(); }
 invalidate(id:string){const e=this.entries.get(id);if(!e)return;if(e.loading)e.dirty=true;else void this.refresh(id);}
 async refresh(id: string, schemas?: string[]) {
  const entry = this.entries.get(id); if (!entry || !this.call) return;
  if (entry.loading) return entry.loading;
  if (schemas) entry.schemas = schemas;
  entry.state = entry.model.schemas.length ? 'Refreshing' : 'Preparing'; entry.degraded = undefined; this.changed();
  const live = () => this.entries.get(id) === entry;
  entry.loading = (async () => {
   try {
    this.metadataRequests++;const context = await this.call!('databaseCompletionContext', [id]); if (!live()) return;
    const model: SqlModel = { label: entry.session.label, database: context.database, defaultSchema: context.defaultSchema, searchPath: context.searchPath, caseSensitiveTables:context.caseSensitiveTables, schemas: [], complete: false };
    if(entry.selectedSchema){model.defaultSchema=entry.selectedSchema;model.searchPath=[entry.selectedSchema,...context.searchPath.filter((s:string)=>s!==entry.selectedSchema)];}
    let relations = 0, columns = 0, bytes = 0; const errors: string[] = [];
    if(!entry.schemas.length&&context.schemasComplete===false)errors.push('Namespace limit reached; narrow namespace scope');
    if (context.fallback) {
     const fallback: SqlModel = await this.call!('databaseModel', [id]); if (!live()) return;
     entry.model = { ...fallback, complete: false }; entry.state = 'Partial'; entry.degraded = 'GenericSQL fallback: engine-specific syntax and full catalog coverage are not validated';
     entry.revision++; this.post({ type: 'context', id, model: entry.model, dialect: entry.session.driver, revision: entry.revision }); return;
    }
    const driver=entry.session.driver;
    const excluded=driver==='postgres'?['information_schema','pg_catalog']:['mysql','mariadb'].includes(driver)?['information_schema','mysql','performance_schema','sys']:driver==='sqlserver'?['sys','INFORMATION_SCHEMA']:[];
    const namespaces = (entry.schemas.length ? entry.schemas : (context.schemas??entry.session.schemas) as string[]).filter(s => !excluded.includes(s) && !(driver==='postgres'&&s.startsWith('pg_')));
    namespaces.sort((a, b) => Number(b === context.defaultSchema) - Number(a === context.defaultSchema));
    const previous = entry.model; entry.model = {...model,schemas:previous.schemas}; entry.revision++;
    this.post({ type: 'context', id, model:entry.model, dialect: entry.session.driver, revision: entry.revision });
    for (const name of namespaces) {
     if (!live()) return;
     const schema: SqlSchema = { name, tables: [] }; const tables = new Map<string, SqlSchema['tables'][number]>();
     try {
      for (const columnPhase of [false, true]) {
       for (let offset = 0; offset <= 500000;) {
        this.metadataRequests++;const page = await this.call!('databaseCompletionPage', [id, name, offset, columnPhase]); if (!live()) return;
        for (const row of page.rows as (string | null)[][]) {
         bytes += new TextEncoder().encode(JSON.stringify(row)).length + 64;
         if (bytes > this.limits.bytes || relations >= this.limits.relations && !columnPhase || columns >= this.limits.columns && columnPhase) { errors.push('Metadata budget reached; narrow namespace scope'); break; }
         if (!columnPhase) { const table = { name: row[0]!, kind: row[1]?.includes('VIEW') ? 'view' as const : 'table' as const, columns: [] }; tables.set(table.name, table); schema.tables.push(table); relations++; }
         else { const table = tables.get(row[0]!); if (table) { table.columns.push({ name: row[1]!, type: row[2]!, nullable: row[3] === 'YES' }); columns++; } }
        }
        entry.relations = relations; entry.columns = columns; entry.bytes = bytes;
        entry.model = { ...model, schemas: [...entry.model.schemas.filter(s => s.name !== name), schema] }; entry.revision++;
        this.post({ type: 'schema', id, schema, complete: false, revision: entry.revision }); this.changed();
        if (!page.hasMore || errors.some(e=>e.startsWith('Metadata budget'))) break;
        const next=page.nextOffset??offset+5000;if(!Number.isInteger(next)||next<=offset)throw Error('Invalid metadata page continuation');offset=next;
       }
       if (errors.some(e => e.startsWith('Metadata budget'))) break;
      }
     } catch (error) {
      errors.push(`${name}: ${String(error)}`);
      const old = previous.schemas.find(s => s.name === name); if (old) { schema.tables = old.tables; entry.degraded = 'Cached metadata is stale'; }
     }
     model.schemas.push(schema);
     entry.model = { ...model, schemas: [...model.schemas] }; entry.revision++;
     this.post({ type: 'schema', id, schema, complete: false, revision: entry.revision });
     if (errors.some(e => e.startsWith('Metadata budget'))) break;
    }
    const waitUntil=Date.now()+15000;while(!this.prepared.has(id)&&live()&&Date.now()<waitUntil)await new Promise(r=>setTimeout(r,20));
    if(!live())return;if(!this.prepared.has(id))errors.push('SQL parser preparation timed out; refresh to retry');
    entry.errors = errors; entry.model = { ...model, complete: !errors.length, errors }; entry.state = errors.length ? 'Partial' : 'Ready'; entry.revision++;
    this.post({ type: 'context', id, model: entry.model, dialect: entry.session.driver, revision: entry.revision });
   } catch (error) { if (live()) { entry.errors = [String(error)]; entry.state = entry.model.schemas.length ? 'Partial' : 'Unavailable'; entry.degraded = 'Metadata unavailable or stale; refresh to retry'; } }
   finally { entry.loading = undefined; entry.lastRefresh = Date.now(); if (live()) {this.changed();if(entry.dirty){entry.dirty=false;void this.refresh(id);}} }
  })();
  return entry.loading;
 }
 async complete(id: string, text: string, offset: number, signal?: AbortSignal): Promise<SqlCompletion | null> {
  const entry = this.entries.get(id); if (!entry || signal?.aborted) return null;
  if (!this.worker) this.restoreWorker();
  if (!this.ready||!this.prepared.has(id)) return null;
  const revision = entry.revision, request = ++this.sequence;
  return new Promise(resolve => {
   const abort = () => { const p = this.pending.get(request); if (p) { clearTimeout(p.timer); this.pending.delete(request); p.finish(null); } };
   const timer = setTimeout(() => this.failWorker('SQL completion exceeded 200 ms; retry or simplify the statement'), 200);
   this.pending.set(request, { id, revision, timer, finish: value => { signal?.removeEventListener('abort', abort); resolve(value); } });
   signal?.addEventListener('abort', abort, { once: true });
   this.post({ type: 'complete', id, revision, request, text, offset });
  });
 }
 disconnect(id: string) {
  this.entries.delete(id);this.prepared.delete(id); this.post({ type: 'forget', id });
  for (const [n, p] of this.pending) if (p.id === id) { clearTimeout(p.timer); this.pending.delete(n); p.finish(null); }
  this.changed();
 }
 reset() { this.entries.clear(); this.bindings.clear(); this.projectDefault = undefined; clearInterval(this.refreshing); this.refreshing = undefined; this.failWorker('Project closed'); }
}
