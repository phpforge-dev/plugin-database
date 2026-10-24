import { PostgreSQL } from 'dt-sql-parser/dist/parser/postgresql';
import { MySQL } from 'dt-sql-parser/dist/parser/mysql';
import { GenericSQL } from 'dt-sql-parser/dist/parser/generic';

export type Dialect = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'sqlserver' | 'oracle';
export type Token = { raw: string; value: string; upper: string; start: number; end: number; quoted: boolean; identifier: boolean; literal: boolean; hidden: boolean };
const parsers = new Map<string, PostgreSQL | MySQL | GenericSQL>();
const dialectWords: Partial<Record<Dialect,string[]>> = {
 sqlite: 'PRAGMA REPLACE VACUUM ATTACH DETACH INDEXED GLOB MATCH REGEXP WITHOUT STRICT RETURNING'.split(' '),
 sqlserver: 'TOP PERCENT TIES APPLY OUTPUT INSERTED DELETED OPTION OFFSET FETCH NEXT ROWS ONLY WITH NOLOCK MERGE GO'.split(' '),
 oracle: 'ROWNUM FETCH FIRST NEXT ROWS ONLY CONNECT START PRIOR NOCYCLE MINUS RETURNING INTO MODEL PIVOT UNPIVOT'.split(' '),
};
const keywordSets=new Map<string,Set<string>>();
export function isSqlKeyword(name:string,dialect:Dialect){
 let words=keywordSets.get(dialect);if(!words){const v=parser(dialect).createLexer('').vocabulary;words=new Set();for(let i=0;i<=v.maxTokenType;i++){const literal=v.getLiteralName(i);if(literal&&/^'[A-Za-z_]+\'$/.test(literal))words.add(literal.slice(1,-1).toUpperCase());}keywordSets.set(dialect,words);}return words.has(name.toUpperCase()) || !!dialectWords[dialect]?.includes(name.toUpperCase());
}
function parser(dialect: Dialect) {
 const key = dialect === 'postgres' ? dialect : ['mysql', 'mariadb'].includes(dialect) ? 'mysql' : 'generic';
 let p = parsers.get(key);
 if (!p) {
  p = key === 'postgres' ? new PostgreSQL() : key === 'mysql' ? new MySQL() : new GenericSQL();
  // Entity collection creates a fresh parser; its default ANTLR listener logs source text.
  // Supply a public error listener so incomplete user SQL never reaches console/logs.
  const create = p.createParser.bind(p); p.createParser = ((input: string, listener = () => {}) => create(input, listener)) as typeof p.createParser;
  parsers.set(key, p);
 }
 return p;
}
export function parseSql(text: string, offset: number, dialect: Dialect) {
 const p = parser(dialect);
 // ANTLR offsets count Unicode code points; Monaco and application ranges use UTF-16.
 const opaque: Token[] = [];
 let input = text;
 if (['sqlite','sqlserver','oracle'].includes(dialect)) {
  // Protect dialect identifiers/literals from GenericSQL's lexer. Offsets remain in UTF-16.
  const rx = /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|[qQ]'([^\s])|[nN]?'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[(?:\]\]|[^\]])*(?:\]|$)/g;
  let m: RegExpExecArray | null;
  while ((m=rx.exec(text))) {
   let raw=m[0], end=rx.lastIndex;
   if(raw.startsWith('/*')&&dialect==='sqlserver') {
    let depth=1,i=m.index+2;while(i<text.length&&depth){if(text.slice(i,i+2)==='/*'){depth++;i+=2;}else if(text.slice(i,i+2)==='*/'){depth--;i+=2;}else i++;}
    end=i;raw=text.slice(m.index,end);rx.lastIndex=end;
   }
   if(m[1] && dialect==='oracle') { const close:Record<string,string>={'[':']','{':'}','(':')','<':'>'};const tail=text.indexOf((close[m[1]]??m[1])+"'",end);end=tail<0?text.length:tail+2;raw=text.slice(m.index,end);rx.lastIndex=end; }
   const hidden=raw.startsWith('--')||raw.startsWith('/*');
   const quoted=/^["`\[]/.test(raw);const closing=raw[0]==='['?']':raw[0];
   const value=quoted?raw.slice(1,raw.endsWith(closing)&&raw.length>1?-1:undefined).replaceAll(closing+closing,closing):raw;
   opaque.push({raw,value,upper:raw.toUpperCase(),start:m.index,end,quoted,identifier:quoted,literal:!hidden&&!quoted,hidden});
  }
  for(const t of [...opaque].reverse())input=input.slice(0,t.start)+t.raw.replace(/[^\r\n]/g,' ')+input.slice(t.end);
 }
 const points = [0]; for (const c of input) points.push(points.at(-1)! + c.length);
 const tokens: Token[] = p.getAllTokens(input).map(t => {
  const raw = t.text ?? ''; const quoted = /^["`\[]/.test(raw);
  const value = quoted ? raw.slice(1, /["`\]]$/.test(raw.slice(1)) ? -1 : undefined).replace(/""/g, '"').replace(/``/g, '`').replace(/\]\]/g, ']') : raw;
  return { raw, value, upper: raw.toUpperCase(), start: points[t.start] ?? t.start, end: points[t.stop + 1] ?? t.stop + 1, quoted,
   identifier: quoted || /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(raw), literal: /^'|^\$[^ ]*\$/.test(raw), hidden: t.channel !== 0 };
 });
 tokens.push(...opaque);tokens.sort((a,b)=>a.start-b.start);
 // Whitespace produced by masking must not cover an opaque identifier at the caret.
 const visibleTokens=tokens.filter(t=>!t.hidden||!/^\s+$/.test(t.raw)||!opaque.some(o=>t.start<o.end&&t.end>o.start));
 const before = input.slice(0, offset), lines = before.split('\n');
 let keywords: string[] = [], contexts: string[] = [], entities = 0, degraded: string | undefined;
 try {
  const position = { lineNumber: lines.length, column: [...lines.at(-1)!].length + 1 };
  const suggestions = p.getSuggestionAtCaretPosition(input, position);
  keywords = suggestions?.keywords ?? []; contexts = suggestions?.syntax.map(s => s.syntaxContextType) ?? [];
  entities = p.getAllEntities(input, position)?.length ?? 0;
 } catch { degraded = 'Incomplete syntax; using bounded token scope recovery'; }
 return { tokens: visibleTokens, keywords: [...new Set([...keywords,...dialectWords[dialect]??[]])], contexts, entities, degraded };
}
