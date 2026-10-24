import type { SqlColumn, SqlItem, SqlModel } from '../sql';
import { parseSql, isSqlKeyword, type Dialect, type Token } from './parser';

export type SqlCompletion = { from: number; to: number; items: SqlItem[]; incomplete: boolean; degraded?: string; parserEntities: number };
type Column = SqlColumn & { source?: string };
type Binding = { name: Token; columns: Column[]; source: string; kind: 'table' | 'view'; schema?: string; aliased?: boolean };
type Scope = { start: number; end: number; bindings: Binding[]; ctes: Map<string, Binding>; outputs: Column[]; children: Scope[]; parent?: Scope; correlated: boolean; select: Token[]; target?: Binding; command: string };
const baseClauses = new Set('SELECT FROM JOIN LEFT RIGHT FULL INNER OUTER CROSS NATURAL ON USING WHERE GROUP BY ORDER HAVING LIMIT OFFSET UNION INTERSECT EXCEPT RETURNING SET VALUES WHEN THEN ELSE END AS INTO UPDATE INSERT DELETE WITH RECURSIVE DISTINCT ALL LATERAL FETCH FOR WINDOW QUALIFY'.split(' '));
const lastIndex = <T>(items: T[], test: (value: T) => boolean) => { for(let i=items.length-1;i>=0;i--)if(test(items[i]))return i;return -1; };
const fake = (name: string): Token => ({ raw: name, value: name, upper: name.toUpperCase(), quoted: false, identifier: true, literal: false, hidden: false, start: 0, end: 0 });
export function quoteName(name: string, dialect: Dialect) {
 const q = dialect === 'mysql' || dialect === 'mariadb' ? '`' : dialect==='sqlserver'?'[':'"';
 const close=q==='['?']':q;
 const plain=dialect==='oracle'?/^[A-Z_][A-Z0-9_$#]*$/:/^[a-z_][a-z0-9_$]*$/;
 return plain.test(name) && !isSqlKeyword(name,dialect) ? name : q + name.replaceAll(close, close + close) + close;
}
export function createResolver(model: SqlModel, dialect: Dialect) {
 const clauses=new Set([...baseClauses,...dialect==='sqlserver'?'TOP PERCENT TIES APPLY OPTION NOLOCK'.split(' '):dialect==='oracle'?'CONNECT START MINUS'.split(' '):[]]);
 const isName = (t?: Token): t is Token => !!t?.identifier && (t.quoted || !clauses.has(t.upper));
 const norm = (name: string) => model.caseSensitiveTables&&dialect==='sqlserver'?name:dialect === 'postgres' ? name.toLowerCase() : dialect === 'oracle' ? name.toUpperCase() : name.toLowerCase();
 const key = (token: Token) => token.quoted && ['postgres', 'oracle'].includes(dialect) ? token.value : norm(token.value);
 const stored = (name: string) => ['postgres', 'oracle'].includes(dialect) ? name : norm(name);
 const same = (token: Token, name: string) => key(token) === stored(name);
 const bindingMatches = (token:Token,name:Token)=>key(token)===key(name);
 const outputName = (token:Token)=>token.quoted?token.value:['postgres','oracle'].includes(dialect)?norm(token.value):token.value;
 const tableSame = (token:Token,name:string)=>model.caseSensitiveTables?token.value===name:same(token,name);
 const relations = model.schemas.flatMap(s => s.tables.map(t => ({ schema: s.name, ...t })));
 const bySchema = new Map<string, typeof relations>();
 const byName=new Map<string,typeof relations>();const relationKey=(name:string)=>model.caseSensitiveTables?name:stored(name);
 const searchPath=model.searchPath??[model.defaultSchema],preferredSchemas=new Map<string,string>();
 for (const r of relations) {
  const list = bySchema.get(stored(r.schema)) ?? []; list.push(r); bySchema.set(stored(r.schema), list);
  const names=byName.get(relationKey(r.name))??[];names.push(r);byName.set(relationKey(r.name),names);
  const rank=searchPath.indexOf(r.schema),previous=preferredSchemas.get(relationKey(r.name));
  if(rank>=0&&(previous===undefined||rank<searchPath.indexOf(previous)))preferredSchemas.set(relationKey(r.name),r.schema);
 }
 function physical(parts: Token[]): Binding | undefined {
  const name = parts.at(-1)!; const schema = parts.at(-2);
  if (parts.length > 2 && !same(parts[0], model.database)) return;
  const path = schema ? [schema.value] : model.searchPath ?? [model.defaultSchema];
  for (const ns of path) {
   const candidates = byName.get(model.caseSensitiveTables?name.value:key(name)) ?? [];
   const table = candidates.find(t => tableSame(name, t.name)&&(schema?tableSame(schema,t.schema):t.schema===ns));
   if (table) return { name, columns: table.columns, source: `${model.database}.${table.schema}.${table.name}`, schema: table.schema, kind: table.kind };
  }
 }
 function complete(text: string, offset: number): SqlCompletion {
  if (text.length > 100000) return { from: offset, to: offset, items: [], incomplete: true, degraded: 'SQL exceeds 100,000 characters', parserEntities: 0 };
  const parsed = parseSql(text, offset, dialect);
  const inside = parsed.tokens.find(t => offset > t.start && (offset < t.end || offset === t.end && (t.literal || t.hidden && !/^\s/.test(t.raw))));
  if (inside?.literal || inside?.hidden && !/^\s/.test(inside.raw)) return { from: offset, to: offset, items: [], incomplete: false, parserEntities: parsed.entities };
  const ts = parsed.tokens.filter(t => !t.hidden);
  const current = ts.find(t => t.identifier && offset >= t.start && offset <= t.end);
  const from = current?.start ?? offset, to = current?.end ?? offset;
  const prefix = current ? text.slice(from + (current.quoted ? 1 : 0), offset).replace(/["`\]]$/, '') : '';
  const before = ts.filter(t => t.end <= from), prev = before.at(-1);
  let lo = 0, hi = ts.length;
  for (let i = 0; i < ts.length; i++) if (ts[i].raw === ';') { if (ts[i].start < offset) lo = i + 1; else { hi = i; break; } }
  const tokens = ts.slice(lo, hi); const pairs = new Map<number, number>(); const stack: number[] = [];
  tokens.forEach((t, i) => { if (t.raw === '(') stack.push(i); if (t.raw === ')') { const a = stack.pop(); if (a !== undefined) pairs.set(a, i); } });
  for (const a of stack) pairs.set(a, tokens.length);
  let degraded = parsed.degraded, blocks = 0;
  const visible = (s: Scope): Binding[] => { const own = s.bindings; return s.correlated && s.parent ? [...own, ...visible(s.parent).filter(r => !own.some(o => key(o.name) === key(r.name)))] : own; };
  function build(a: number, b: number, inherited: Map<string, Binding>, parent?: Scope, correlated = false, depth = 0): Scope {
   const scope: Scope = { start: tokens[a]?.start ?? 0, end: tokens[b]?.start ?? text.length, bindings: [], ctes: new Map(inherited), outputs: [], children: [], parent, correlated, select: [], command: '' };
   if (depth > 24 || ++blocks > 256) { degraded = 'SQL scope/depth limit reached'; return scope; }
   let start = a;
   if (tokens[start]?.upper === 'WITH') {
    let i = start + 1; const explicitRecursive = tokens[i]?.upper === 'RECURSIVE'; const recursive=explicitRecursive||['oracle','sqlserver'].includes(dialect); if (explicitRecursive) i++;
    while (i < b && isName(tokens[i])) {
     const name = tokens[i++]; let names: Token[] = [];
     if (tokens[i]?.raw === '(') { const end = pairs.get(i) ?? b; names = tokens.slice(i + 1, end).filter(isName); i = end + 1; }
     if (tokens[i]?.upper !== 'AS') break; i++;
     if (tokens[i]?.upper === 'NOT') i++; if (tokens[i]?.upper === 'MATERIALIZED') i++;
     if (tokens[i]?.raw !== '(') break;
     const end = Math.min(pairs.get(i) ?? b, b);
     const placeholder: Binding = { name, columns: names.map(t => ({ name: outputName(t), type: 'unknown' })), source: `CTE ${name.value}`, kind: 'table' };
     const env = new Map(scope.ctes); if (recursive) env.set(key(name), placeholder);
     const child = build(i + 1, end, env, undefined, false, depth + 1); scope.children.push(child);
     let columns = child.outputs;
     if (names.length) columns = names.map((t, n) => ({ ...columns[n], name: outputName(t), type: columns[n]?.type ?? 'unknown' }));
     placeholder.columns = columns; scope.ctes.set(key(name), placeholder);
     i = end + 1; if (tokens[i]?.raw !== ',') { start = i; break; } i++;
    }
   }
   const top: number[] = [];
   for (let i = start; i < b; i++) { top.push(i); if (tokens[i].raw === '(') i = Math.min(pairs.get(i) ?? b, b); }
   const select = top.find(i => tokens[i].upper === 'SELECT'); scope.command = tokens[start]?.upper ?? '';
   const fromIndex = top.find(i => tokens[i].upper === 'FROM');
   const setEnd = top.find(i => ['UNION', 'INTERSECT', 'EXCEPT', ...(dialect==='oracle'?['MINUS']:[])].includes(tokens[i].upper)) ?? b;
   if (select !== undefined) {
    let projection=select+1;while(['DISTINCT','ALL'].includes(tokens[projection]?.upper))projection++;
    if(dialect==='sqlserver'&&tokens[projection]?.upper==='TOP') { projection++;if(tokens[projection]?.raw==='(')projection=(pairs.get(projection)??projection)+1;else projection++;if(tokens[projection]?.upper==='PERCENT')projection++;if(tokens[projection]?.upper==='WITH'&&tokens[projection+1]?.upper==='TIES')projection+=2; }
    scope.select = tokens.slice(projection, fromIndex ?? setEnd);
   }
   let expect = false, inFrom = false;
   const handled = new Set<number>();
   for (let i = start; i < Math.min(b, setEnd); i++) {
    const token = tokens[i];
    if (['FROM', 'JOIN', 'UPDATE', 'INTO', ...(dialect==='sqlserver'?['APPLY']:[])].includes(token.upper)) { expect = true; inFrom = true; continue; }
    if (['WHERE', 'GROUP', 'ORDER', 'ON', 'SET', 'VALUES', 'RETURNING', 'HAVING'].includes(token.upper)) { expect = false; if (token.upper !== 'ON') inFrom = false; }
    if (token.raw === ',' && inFrom) { expect = true; continue; }
    if (expect) {
     let binding: Binding | undefined; const lateral = token.upper === 'LATERAL' && ['postgres','mysql','mariadb','oracle'].includes(dialect) || dialect==='sqlserver'&&tokens[i-1]?.upper==='APPLY'; if (token.upper==='LATERAL') i++;
     if (tokens[i]?.raw === '(') {
      const end = Math.min(pairs.get(i) ?? b, b); const child = build(i + 1, end, scope.ctes, lateral?{...scope,bindings:[...scope.bindings]}:scope, lateral, depth + 1); scope.children.push(child); handled.add(i); i = end;
      binding = { name: fake(''), columns: child.outputs, source: 'Derived query', kind: 'table' };
     } else if (isName(tokens[i])) {
      const parts = [tokens[i]]; while (tokens[i + 1]?.raw === '.' && isName(tokens[i + 2])) { parts.push(tokens[i + 2]); i += 2; }
      binding = parts.length === 1 ? scope.ctes.get(key(parts[0])) ?? physical(parts) : physical(parts);
      if (binding) binding = { ...binding, name: parts.at(-1)! };
     }
     if (tokens[i + 1]?.upper === 'AS') i++;
     if (isName(tokens[i + 1])) { const name = tokens[++i]; if (binding) binding = { ...binding, name,aliased:true }; }
     if (binding) {
      if (tokens[i + 1]?.raw === '(' && binding.source === 'Derived query') { const end = pairs.get(i + 1) ?? b; const names = tokens.slice(i + 2, end).filter(isName); binding.columns = names.map((t, n) => ({ ...binding!.columns[n], name: outputName(t), type: binding!.columns[n]?.type ?? 'unknown' })); i = end; }
      scope.bindings.push(binding); if (['UPDATE', 'INSERT'].includes(scope.command)) scope.target ??= binding;
     }
     expect = false; continue;
    }
    if (token.raw === '(') {
     const end = Math.min(pairs.get(i) ?? b, b);
     if (!handled.has(i) && ['SELECT', 'WITH'].includes(tokens[i + 1]?.upper)) scope.children.push(build(i + 1, end, scope.ctes, scope, true, depth + 1));
     else if (!handled.has(i)) {
      // Discover subqueries inside expressions/functions without leaking sibling bindings.
      for (let j = i + 1; j < end; j++) if (tokens[j].raw === '(' && ['SELECT', 'WITH'].includes(tokens[j + 1]?.upper)) { const close = Math.min(pairs.get(j) ?? end, end); scope.children.push(build(j + 1, close, scope.ctes, scope, true, depth + 1)); j = close; }
     }
     i = end;
    }
   }
   const chunks: Token[][] = []; let chunk: Token[] = [], nesting = 0;
   for (const t of scope.select) { if (t.raw === ',' && !nesting) { chunks.push(chunk); chunk = []; } else { chunk.push(t); if (t.raw === '(') nesting++; if (t.raw === ')') nesting--; } } if (chunk.length) chunks.push(chunk);
   for (const c of chunks) {
    if (c.length === 1 && c[0].raw === '*') { scope.outputs.push(...scope.bindings.flatMap(r => r.columns)); continue; }
    if (c.length === 3 && c[1].raw === '.' && c[2].raw === '*') { scope.outputs.push(...scope.bindings.find(r => bindingMatches(c[0], r.name))?.columns ?? []); continue; }
    const as = lastIndex(c, t => t.upper === 'AS');
    const alias = as >= 0 ? c[as + 1] : c.length > 1 && isName(c.at(-1)) && c.at(-2)?.raw !== '.' && (c.at(-2)?.raw === ')' || c.length === 2) ? c.at(-1) : undefined;
    const expr = as >= 0 ? c.slice(0, as) : alias ? c.slice(0, -1) : c;
    const simple = expr.length === 1 && isName(expr[0]) || expr.length === 3 && expr[1].raw === '.' && isName(expr[2]);
    const col = simple ? expr.at(-1) : undefined;
    const sources = col ? visible(scope).filter(r => expr.length === 1 || bindingMatches(expr[0], r.name)).flatMap(r => r.columns.filter(v => same(col, v.name))) : [];
    const name = alias ? outputName(alias) : col ? outputName(col) : undefined;
    if (name) scope.outputs.push({ name, type: sources.length === 1 ? sources[0].type : 'unknown', source: sources.length === 1 ? sources[0].source : undefined });
   }
   if (setEnd < b) { const next = setEnd + (tokens[setEnd + 1]?.upper === 'ALL' ? 2 : 1); const sibling = build(next, b, scope.ctes, parent, correlated, depth + 1); scope.children.push(sibling); scope.end = tokens[setEnd].start; scope.outputs = scope.outputs.map((c, n) => ({ ...c, type: c.type === sibling.outputs[n]?.type ? c.type : 'unknown' })); }
   return scope;
  }
  const root = build(0, tokens.length, new Map());
  function at(s: Scope): Scope | undefined { for (const child of s.children) { const found = at(child); if (found) return found; } return offset >= s.start && offset <= s.end ? s : undefined; }
  const scope = at(root) ?? root;
  const bindings = visible(scope); let items: SqlItem[] = [];
  const insert = (name: string) => {const open=current?.raw[0],close=open==='['?']':open;return current?.quoted?open+name.replaceAll(close!,close!+close!)+close:quoteName(name,dialect);};
  const columnItems = (bs: Binding[], qualified: boolean) => bs.flatMap(r => r.columns.map(c => {
   const ambiguous = !qualified && bs.filter(b => b.columns.some(v => stored(v.name) === stored(c.name))).length > 1;
   const value = ambiguous ? `${quoteName(outputName(r.name), dialect)}.${insert(c.name)}` : insert(c.name);
   return { label: ambiguous ? `${r.name.value}.${c.name}` : c.name, insertText: value, kind: 'column' as const, detail: ` (${r.name.value})`, description: `${c.type} · ${r.source}` };
  }));
  const addTables = (schema?: Token) => {
   if (!schema) for (const cte of scope.ctes.values()) items.push({ label: cte.name.value, insertText: insert(cte.name.value), kind: 'table', description: cte.source });
   const names = new Set<string>();
   for (const r of schema?bySchema.get(key(schema))??[]:relations) {
    if (schema && !tableSame(schema, r.schema)) continue;
    if (!schema && scope.ctes.has(stored(r.name))) continue;
    const preferred = preferredSchemas.get(relationKey(r.name));
    const qualify = !schema && preferred !== r.schema;
    const label = qualify ? `${r.schema}.${r.name}` : r.name;
    if(prefix&&!label.toLowerCase().startsWith(prefix.toLowerCase())&&!r.name.toLowerCase().startsWith(prefix.toLowerCase()))continue;
    if (names.has(label)) continue; names.add(label);
    items.push({ label, insertText: qualify ? `${quoteName(r.schema, dialect)}.${insert(r.name)}` : insert(r.name), kind: r.kind, detail: ` (${r.schema})`, description: model.label });
   }
   if (!schema) items.push(...model.schemas.map(s => ({ label: s.name, insertText: insert(s.name), kind: 'schema' as const, description: model.label })));
  };
  const beforeScope = tokens.filter(t => t.end <= from && t.start >= scope.start);
  let nesting = 0; const topBefore: Token[] = [];
  for (const t of beforeScope) { if (t.raw === ')') nesting--; if (!nesting) topBefore.push(t); if (t.raw === '(') nesting++; }
  const clause = [...topBefore].reverse().find(t => clauses.has(t.upper))?.upper;
  const inInsertColumns = scope.command === 'INSERT' && beforeScope.some(t => t.raw === '(') && !beforeScope.some(t => t.upper === 'VALUES' || t.upper === 'SELECT');
  const relationContext = !inInsertColumns && (['FROM', 'JOIN', 'INTO', 'UPDATE', ...(dialect==='sqlserver'?['APPLY']:[])].includes(clause ?? '') || parsed.contexts.includes('table') && !scope.bindings.length);
  if (prev?.raw === '.') {
   const qualifier = before.at(-2);
   const outer = before.at(-3)?.raw==='.'?before.at(-4):undefined;
   const binding = qualifier && bindings.find(r => bindingMatches(qualifier, r.name)&&(!outer||!r.aliased&&!!r.schema&&tableSame(outer,r.schema)));
   if (binding && !relationContext) items = columnItems([binding], true);
   else if (qualifier && (relationContext || !binding)) {
    if (before.at(-3)?.raw !== '.' || before.at(-4) && same(before.at(-4)!, model.database)) {
     const isSchema = model.schemas.some(s => same(qualifier, s.name)); if (isSchema && relationContext) addTables(qualifier);
    }
   }
  } else if (relationContext) addTables();
  else {
   const insertList = scope.command === 'INSERT' && beforeScope.some(t => t.raw === '(') && !beforeScope.some(t => t.upper === 'VALUES' || t.upper === 'SELECT');
   const updateTarget = scope.command === 'UPDATE' && clause === 'SET' && !topBefore.slice(lastIndex(topBefore, t => t.upper === 'SET') + 1).some(t => t.raw === '=') || scope.command === 'UPDATE' && topBefore.at(-1)?.raw === ',';
   items = columnItems(insertList || updateTarget ? scope.target ? [scope.target] : [] : bindings, false);
   if (insertList) { const used = beforeScope.slice(beforeScope.findIndex(t => t.raw === '(') + 1).filter(isName); items = items.filter(c => !used.some(t => same(t, c.label))); }
   if (['ORDER', 'BY', 'GROUP'].includes(clause ?? '') && (dialect !== 'sqlserver' || topBefore.some(t => t.upper === 'ORDER'))) items.push(...scope.outputs.map(c => ({ label: c.name, insertText: insert(c.name), kind: 'column' as const, description: `${c.type} · SELECT output` })));
   if (!insertList && !updateTarget) items.push(...parsed.keywords.map(label => ({ label, kind: 'keyword' as const })));
  }
  const match = prefix.toLowerCase(); const seen = new Set<string>();
  items = items.filter(i => (i.label.toLowerCase().startsWith(match) || i.label.split('.').at(-1)!.toLowerCase().startsWith(match)) && !seen.has(`${i.kind}:${i.label}:${i.description}`) && !!seen.add(`${i.kind}:${i.label}:${i.description}`));
  items.sort((a, b) => Number(a.kind === 'keyword') - Number(b.kind === 'keyword') || Number(b.label.toLowerCase() === match) - Number(a.label.toLowerCase() === match) || Number(b.label.toLowerCase().startsWith(match))-Number(a.label.toLowerCase().startsWith(match)) || a.label.localeCompare(b.label));
  return { from, to, items: items.slice(0, 250), incomplete: items.length > 250 || model.complete === false, degraded, parserEntities: parsed.entities };
 }
 return { complete };
}
