import { bladeCode, segments } from '../language/php-source';
import { looksLikeSql } from '../sql';
/** Decode PHP literals without executing PHP. Each SQL UTF-16 boundary maps to its host boundary. */
export function sqlRegion(text: string, offset: number, blade = false) {
 const segment = segments(blade ? bladeCode(text) : text,blade).find(s=>s.kind==='string'&&offset>s.start&&offset<s.end);
 const literal = segment?.quote ? {...segment,quote:segment.quote,closed:text[segment.end-1]===segment.quote}:undefined;
 if (!literal || !['"', "'"].includes(literal.quote)) return null;
 const start = literal.start + 1, end = literal.closed ? literal.end - 1 : literal.end;
 const raw = text.slice(start, end);
 if (!looksLikeSql(raw)) return null;
 if (/\.\s*$/.test(text.slice(0, literal.start)) || /^\s*\./.test(text.slice(literal.end))) return { unsafe: 'Concatenated SQL cannot be completed safely' } as const;
 let sql = ''; const boundaries = [start];
 for (let i = 0; i < raw.length; i++) {
  let c = raw[i];
  if (literal.quote === '"' && c === '$') return { unsafe: 'Interpolated SQL cannot be completed safely' } as const;
  if (c === '\\') {
   const next = raw[i + 1];
   if (next === literal.quote || next === '\\' || literal.quote === '"' && next === '$') { c = next; i++; }
   else if (literal.quote === '"' && next && 'nrt'.includes(next)) { c = { n: '\n', r: '\r', t: '\t' }[next as 'n']; i++; }
   else if (literal.quote === '"') return { unsafe: 'Unsupported PHP escape in SQL literal' } as const;
  }
  sql += c; boundaries.push(start + i + 1);
 }
 const local = boundaries.indexOf(offset); if (local < 0) return { unsafe: 'Cursor is inside an escape sequence' } as const;
 return { unsafe: undefined, sql, local, boundaries, encode: (value: string) => value.replaceAll('\\', '\\\\').replaceAll(literal.quote, '\\' + literal.quote).replaceAll(literal.quote === '"' ? '$' : '\0', literal.quote === '"' ? '\\$' : '\0') };
}
