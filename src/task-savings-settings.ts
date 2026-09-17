import { relayHealth } from "./compaction-policy-settings";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings } from "./task-savings";
import { inspectRelaySettings, replaceRelaySettings, withRelaySettingsLock } from "./relay-settings";

export class TaskSavingsSettings {
  private busy = false;
  constructor(private root: string, private fetcher: typeof fetch = fetch) {}
  private async inspect() {
    return inspectRelaySettings(this.root, async ({ path, raw, settings, current }) => {
      const saved = validateTaskSavings(settings.taskSavings ?? DEFAULT_TASK_SAVINGS);
      let health: any = null;
      try { health = await relayHealth(settings,this.fetcher); } catch { /* No endpoint details in status. */ }
      const configurable = health?.schemaVersion >= 3 && !!health.taskSavings;
      return {path,raw,settings,saved,current,configurable,
        supported:health?.savingsModelSupported === true,
        effective:configurable ? validateTaskSavings(health.taskSavings) : null};
    });
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
    try {
      return await withRelaySettingsLock(this.root, async () => {
        const written: {path:string;before:string;after:string}[]=[];
        try {
          const entries=await this.inspect(),current=entries[0]!;
          if(!current.configurable || patch.enabled === true && !current.supported) throw new Error("relay_unavailable");
          const bypassThreads=[...new Set([...(current.saved.bypassThreads ?? []),...(patch.bypassThread?[patch.bypassThread]:[])])];
          const policy=validateTaskSavings({...current.saved,...(typeof patch.enabled==='boolean'?{enabled:patch.enabled}:{}),bypassThreads});
          for(const entry of entries.filter(e=>e.configurable)) {
            const after=JSON.stringify({...entry.settings,taskSavings:policy},null,2)+"\n";
            await replaceRelaySettings(entry.path,entry.raw,after);written.push({path:entry.path,before:entry.raw,after});
          }
          await Bun.sleep(650);
          return await this.status();
        } catch (error) {
          for(const item of written.reverse()) {try{await replaceRelaySettings(item.path,item.after,item.before);}catch{/* Preserve concurrent user edits. */}}
          throw error;
        }
      });
    } catch(error) {
      throw new Error("savings_update_failed");
    } finally {this.busy=false;}
  }
}
