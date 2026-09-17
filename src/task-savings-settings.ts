import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { relayHealth } from "./compaction-policy-settings";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings } from "./task-savings";

export class TaskSavingsSettings {
  private busy = false;
  constructor(private root: string, private fetcher: typeof fetch = fetch) {}
  private async inspect() {
    const manifest = JSON.parse(await readFile(join(this.root,"current.json"),"utf8"));
    const paths = [...new Set<string>([manifest.settings_path,
      ...(Object.values(manifest.profile_settings ?? {}) as string[]), ...(manifest.retired_settings ?? [])])];
    if (!paths.length || paths.length > 32) throw new Error("invalid_installation");
    const root = await realpath(this.root);
    return Promise.all(paths.map(async (path,index) => {
      if (typeof path !== "string" || !/^(?:settings\.json|releases\/\d+\/settings\.json)$/.test(relative(resolve(this.root),resolve(path))) ||
          await realpath(path) !== join(root,relative(resolve(this.root),resolve(path)))) throw new Error("invalid_installation");
      const raw = await readFile(path,"utf8"), settings = JSON.parse(raw);
      const saved = validateTaskSavings(settings.taskSavings ?? DEFAULT_TASK_SAVINGS);
      let health: any = null;
      try { health = await relayHealth(settings,this.fetcher); } catch { /* No endpoint details in status. */ }
      const configurable = health?.schemaVersion >= 3 && !!health.taskSavings;
      return {path,raw,settings,saved,current:index===0,configurable,
        supported:health?.savingsModelSupported === true,
        effective:configurable ? validateTaskSavings(health.taskSavings) : null};
    }));
  }
  async status() {
    try {
      const entries = await this.inspect(), current = entries[0]!;
      return {...current.saved,configurable:current.configurable,supported:current.supported,
        generations:entries.length,compatible:entries.filter(e=>e.configurable).length,
        applied:entries.filter(e=>e.effective && JSON.stringify(e.effective)===JSON.stringify(current.saved)).length};
    } catch { return null; }
  }
  async configure(input: unknown) {
    if (this.busy) throw new Error("policy_busy");
    if (!input || typeof input !== "object") throw new Error("invalid_policy");
    const patch = input as any;
    if (typeof patch.enabled !== "boolean" && !(typeof patch.bypassThread === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(patch.bypassThread))) throw new Error("invalid_policy");
    this.busy=true;
    const written: {path:string;before:string;after:string}[]=[];
    try {
      const entries=await this.inspect(),current=entries[0]!;
      if(!current.configurable || patch.enabled === true && !current.supported) throw new Error("relay_unavailable");
      const bypassThreads=[...new Set([...(current.saved.bypassThreads ?? []),...(patch.bypassThread?[patch.bypassThread]:[])])];
      const policy=validateTaskSavings({...current.saved,...(typeof patch.enabled==='boolean'?{enabled:patch.enabled}:{}),bypassThreads});
      for(const entry of entries.filter(e=>e.configurable)) {
        const after=JSON.stringify({...entry.settings,taskSavings:policy},null,2)+"\n";
        await this.replace(entry.path,entry.raw,after);written.push({path:entry.path,before:entry.raw,after});
      }
      await Bun.sleep(650);
      return await this.status();
    } catch(error) {
      for(const item of written.reverse()) {try{await this.replace(item.path,item.after,item.before);}catch{/* Preserve concurrent user edits. */}}
      throw new Error("savings_update_failed");
    } finally {this.busy=false;}
  }
  private async replace(path:string,expected:string,content:string) {
    const temp=path+"."+randomUUID()+".tmp";
    try {
      await writeFile(temp,content,{mode:0o600,flag:"wx"});
      if(await readFile(path,"utf8")!==expected) throw new Error("settings_changed");
      await rename(temp,path);
    } finally {await unlink(temp).catch(()=>{});}
  }
}
