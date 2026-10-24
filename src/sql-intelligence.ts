import workerSource from './worker-source';
import {SqlIntelligence} from '../shared/sql-intelligence/catalog';
export const sqlIntelligence=new SqlIntelligence(()=>{const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));const worker=new Worker(url);const terminate=worker.terminate.bind(worker);worker.terminate=()=>{terminate();URL.revokeObjectURL(url);};return worker;});
