import type { ResetSignal } from "./classify";
export function resetScope(signal:ResetSignal):string {
  // A short reply keeps any audience restriction inherited from its parent.
  const text=[signal.change?.evidence??signal.timeHint??signal.text,signal.scopeHint??""].join("\n");
  const plans=[...text.matchAll(/\b(Plus|Pro|Business|Enterprise|Team|Free|students?)\b/gi)].map(m=>m[1]!.toLowerCase()).sort();
  const window=/\bweekly\b/i.test(text)?"weekly":/\b(?:short.term|five.hour|5.hour)\b/i.test(text)?"short":"unspecified";
  const audience=plans.length?[...new Set(plans)].join(","):/\bglobal\b|\bsystem.wide\b|\beveryone\b|\ball\s+(?:users|accounts|plans|subscriptions)\b/i.test(text)?"global":"unspecified";
  return `${signal.benefitKind??"reset"}:${signal.resetKind==="banked"?"banked":"direct"}:${audience}:${window}`;
}
/** Explicit reference edges only. Same author/day/scope is a search candidate,
 * never an automatic merger. No network or model call occurs here. */
export function resetEventIds(signals:ResetSignal[]):Map<string,string> {
  const roots=new Map<string,string>(), byId=new Map(signals.map(s=>[s.sourcePostId??s.id,s]));
  const root=(id:string):string=>{ const parent=roots.get(id); return parent&&parent!==id?root(parent):id; };
  for(const s of signals){const id=s.sourcePostId??s.id; roots.set(id,root(id));}
  for(const s of signals)for(const ref of s.relatedSourceIds??[]) {
    const other=byId.get(ref); if(!other||(s.provider??"codex")!==(other.provider??"codex")||resetScope(s)!==resetScope(other))continue;
    const a=root(s.sourcePostId??s.id), b=root(ref); roots.set(a,[a,b].sort()[0]!);roots.set(b,[a,b].sort()[0]!);
  }
  return new Map(signals.map(s=>[s.sourcePostId??s.id,`${s.provider??"codex"}:${root(s.sourcePostId??s.id)}`]));
}
export function explicitlyRelated(a:ResetSignal,b:ResetSignal):boolean {
  const aId=a.sourcePostId??a.id,bId=b.sourcePostId??b.id;
  return aId===bId || (a.relatedSourceIds??[]).includes(bId)||(b.relatedSourceIds??[]).includes(aId);
}

/** Provider bucket IDs encode minutes for current Codex windows. Legacy aliases
 * and Claude's stable bucket names remain accepted during migration. */
export function resetBucketWindow(bucket:string):"weekly"|"short"|null {
  if(/(?:^|:)weekly$/.test(bucket)||/^seven_day(?:_|$)/.test(bucket))return "weekly";
  if(/(?:^|:)(?:primary|session|short|five_hour)$/.test(bucket)||bucket==="five_hour")return "short";
  const minutes=bucket.match(/:(?:primary|secondary):(\d+)$/)?.[1];
  if(minutes!==undefined){const duration=Number(minutes);if(duration===10080)return "weekly";if(duration>0&&duration<=1440)return "short";}
  return null;
}
export function resetScopeMatchesBucket(scope:string,bucket:string):boolean {
  if(scope.endsWith(":weekly"))return resetBucketWindow(bucket)==="weekly";
  if(scope.endsWith(":short"))return resetBucketWindow(bucket)==="short";
  return true;
}
