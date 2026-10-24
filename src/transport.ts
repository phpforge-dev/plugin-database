import {generateDdl,shortType} from '../shared/sql-ddl';
import {statements,changesSqlCatalog} from '../shared/sql';
import type {SqlIntelligence} from '../shared/sql-intelligence/catalog';
type Call=(method:string,args:unknown[])=>Promise<any>;
/** Database-specific IPC adaptation belongs to the contribution; the host still authorizes calls. */
export function createDatabaseTransport(catalog:Pick<SqlIntelligence,'connect'|'disconnect'|'invalidate'|'reset'>){
 const redis=new Set<string>();
 const transport=async(method:string,args:unknown[],call:Call)=>{
  if(!method.startsWith('database'))throw Error('Unsupported database operation');
  if(method==='databaseDdl'){
   const data=await call('databaseDdlData',args);
   return typeof data==='string'?data:generateDdl(data.name,data.columns,data.keys,data.primaryKeys,data.current,data.owner);
  }
  if(method==='databaseExecute'){
   const text=String(args[1]);args[1]=redis.has(String(args[0]))?text.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')):statements(text).map(statement=>statement.text.trim()).filter(Boolean);
  }
  const result=await call(method,args);
  if(method==='databaseModel')for(const schema of result.schemas)for(const table of schema.tables)for(const column of table.columns)column.type=shortType(column.type,column.udt??column.type);
  if(method==='databaseConnect'){if(result.driver==='redis')redis.add(result.id);else catalog.connect(result);}
  if(method==='databaseDisconnect'){redis.delete(String(args[0]));catalog.disconnect(String(args[0]));}
  if(method==='databaseExecute'&&result.some((row:any)=>row.kind!=='error'&&changesSqlCatalog(row.statement)))catalog.invalidate(String(args[0]));
  return result;
 };
 return{transport,reset(){redis.clear();catalog.reset();}};
}
