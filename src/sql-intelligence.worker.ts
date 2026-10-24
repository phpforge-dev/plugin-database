import { createResolver } from '../shared/sql-intelligence/resolve';
import type { Dialect } from '../shared/sql-intelligence/parser';
import type { SqlModel, SqlSchema } from '../shared/sql';
const catalogs = new Map<string, { model: SqlModel; dialect: Dialect; revision: number; resolver?: ReturnType<typeof createResolver> }>();
const warmed=new Set<string>();
self.onmessage = event => {
 const m = event.data;
 try {
  if (m.type === 'reset') { catalogs.clear(); return; }
  if (m.type === 'forget') { catalogs.delete(m.id); return; }
  if (m.type === 'context') {
   if(!warmed.has(m.dialect)){
    const warm=createResolver({...m.model,schemas:[]},m.dialect);
    for(const marked of ['SELECT |','SELECT u.| FROM users u','SELECT * FROM us|','SELECT * FROM billing.us|','WITH a AS (SELECT email AS contact FROM users) SELECT a.| FROM a','SELECT d.| FROM (SELECT id FROM users) d','SELECT * FROM users u WHERE EXISTS (SELECT u.| FROM orders o)','INSERT INTO users (id, |) VALUES (1,2)','UPDATE users SET | WHERE id=1'])warm.complete(marked.replace('|',''),marked.indexOf('|'));
    warmed.add(m.dialect);
   }
   catalogs.set(m.id, { model: m.model, dialect: m.dialect, revision: m.revision }); self.postMessage({ type: 'context-ready',id:m.id }); return;
  }
  const catalog = catalogs.get(m.id); if (!catalog) return;
  if (m.type === 'schema') {
   const schemas = catalog.model.schemas.filter(s => s.name !== m.schema.name);
   catalog.model = { ...catalog.model, schemas: [...schemas, m.schema as SqlSchema], complete: m.complete };
   catalog.revision = m.revision; catalog.resolver = undefined; return;
  }
  if (m.type === 'complete') {
   if (m.revision !== catalog.revision) { self.postMessage({ request: m.request, result: null }); return; }
   catalog.resolver ??= createResolver(catalog.model, catalog.dialect);
   self.postMessage({ request: m.request, result: catalog.resolver.complete(m.text, m.offset), revision: catalog.revision });
  }
 } catch (error) { self.postMessage({ request: m.request, error: String(error) }); }
};
self.postMessage({ type: 'ready' });
