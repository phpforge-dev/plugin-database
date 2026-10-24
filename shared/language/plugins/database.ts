import { bladeCode, literalAt, position } from '../php-source';
import { looksLikeSql, sqlComplete, sqlReferenceAt, type SqlItem, type SqlModel } from '../../sql';
import { CompletionKind, type CodeCompletion, type CodeSite, type IdePlugin, type PluginLocation } from './api';
import { sqlRegion } from '../../sql-intelligence/embedded';
import type { SqlCompletion } from '../../sql-intelligence/resolve';

/** Fontes de dados conectadas na IDE; o plugin nunca recebe credenciais. */
export type DatabaseServices = { sessions(): Promise<{ id: string; model: SqlModel }[]>; active?(path: string): { id: string; model: SqlModel } | undefined; complete?(id: string, text: string, offset: number): Promise<SqlCompletion | null>; ddl(id: string, schema: string, table: string): Promise<string> };

const kinds: Record<SqlItem['kind'], number> = { column: CompletionKind.Field, table: 22, view: 22, schema: CompletionKind.Module, keyword: CompletionKind.Keyword, columns: 15 };

/** SQL em strings PHP: completion de tabelas/colunas e navegação para o DDL gerado. */
export class DatabasePlugin implements IdePlugin {
 readonly id = 'database';
 readonly name = 'Bancos de dados';
 readonly hidden = true;
 constructor(private services: DatabaseServices) {}
 async detect() { return {}; }
 /** String SQL sob o cursor: conteúdo bruto e offset dentro dela. */
 private sql(site: CodeSite) {
  const source = site.blade ? bladeCode(site.text) : site.text;
  const literal = literalAt(source, site.offset, site.blade);
  if (!literal || literal.quote === '<<<') return null;
  const start = literal.start + 1; const raw = site.text.slice(start, literal.closed ? literal.end - 1 : literal.end);
  return looksLikeSql(raw) ? { raw, start, local: site.offset - start } : null;
 }
 private async model(path: string) { if(this.services.active)return this.services.active(path);const sessions=await this.services.sessions().catch(()=>[]);return sessions.length===1?sessions[0]:undefined; }
 async completeCode(site: CodeSite): Promise<CodeCompletion | null> {
  if(this.services.complete){
   const region=sqlRegion(site.text,site.offset,site.blade);if(!region)return null;
   if(region.unsafe)return {from:site.offset,items:[]};
   const session=await this.model(site.path);if(!session)return {from:site.offset,items:[]};
   const result=await this.services.complete(session.id,region.sql,region.local);if(!result)return {from:site.offset,items:[]};
   return {from:region.boundaries![result.from],to:region.boundaries![result.to],incomplete:result.incomplete,items:result.items.map(i=>({label:i.label,insertText:region.encode!(i.insertText??i.label),kind:kinds[i.kind],labelDetails:{detail:i.detail,description:i.description}}))};
  }
  const sql = this.sql(site); if (!sql) return null;
  const session = await this.model(site.path); if (!session) return null;
  const result = sqlComplete(session.model, sql.raw, sql.local);
  return { from: sql.start + result.from, items: result.items.map(i => ({ label: i.label, kind: kinds[i.kind], ...(i.detail || i.description ? { labelDetails: { detail: i.detail, description: i.description } } : {}) })) };
 }
 async defineCode(site: CodeSite): Promise<PluginLocation[] | null> {
  const sql = this.sql(site); if (!sql) return null;
  const session = await this.model(site.path); if (!session) return null;
  const ref = sqlReferenceAt(session.model, sql.raw, sql.local);
  if (!ref) return [];
  const content = await this.services.ddl(session.id, ref.schema, ref.table);
  // Destino como no DDL observado: nome da tabela em `create table` ou início da linha da coluna.
  const escaped = (ref.column ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = ref.column ? new RegExp(`^(\\s+)[\`"]?${escaped}[\`"]?\\b`, 'mi').exec(content) : /create (?:table|view)\s+/i.exec(content);
  const at = !match ? 0 : ref.column ? match.index + match[1].length : match.index + match[0].length;
  const target = position(content, Math.max(at, 0));
  return [{ uri: `php-ide-ddl:///${encodeURIComponent(session.model.label)}/${encodeURIComponent(ref.schema)}/${encodeURIComponent(ref.table)}.sql`, range: { start: target, end: target }, content, title: ref.table }];
 }
}
