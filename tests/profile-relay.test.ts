import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectProfileRelay } from "../src/profile-relay";
import { startCompactionProxy } from "../src/codex-compaction";
import { CompactionStatusReader } from "../src/compaction-status";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { ModelNotifications } from "../src/model-notifications";

test("quota-only installs do not enable routing; manager failures stay sanitized", async () => {
  const root=await mkdtemp(join(tmpdir(),"qp-profile-relay-"));
  let calls=0;
  try {
    const runner=async(home:string)=>{expect(home).toBe('/profile/two');calls++;return true;};
    expect(await connectProfileRelay('/profile/two',root,runner)).toBe(false);
    expect(calls).toBe(0);
    await writeFile(join(root,'current.json'),'{}');
    expect(await connectProfileRelay('/profile/two',root,runner)).toBe(true);
    expect(calls).toBe(1);
    await expect(connectProfileRelay('/profile/two',root,async()=>{throw new Error('secret URL');})).rejects.toThrow('profile_relay_failed');
  }finally{await rm(root,{recursive:true,force:true});}
});

test("profile relay registration preserves primary, retains old generations and disables every linked profile",async()=>{
 const process=Bun.spawn(['python3','-B','tests/profile_relay_registration.py'],{stdout:'pipe',stderr:'pipe'});
 expect(await new Response(process.stderr).text()).toBe('');
 expect(await process.exited).toBe(0);
});

test("compaction through both profile relays reaches the native notification outbox independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "qp-profile-notices-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const relays: ReturnType<typeof startCompactionProxy>[] = [];
  try {
    const paths: string[] = [];
    for (let index = 1; index <= 2; index++) {
      const directory = join(root, "releases", String(index));
      await mkdir(directory, { recursive: true });
      const token = String(index).repeat(48);
      const relay = startCompactionProxy({ token, fetchUpstream: async (_url, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe("gpt-5.6-sol");
        return new Response('data: {"type":"response.completed","response":{"model":"gpt-5.6-sol"}}\n\n',
          { headers: { "content-type": "text/event-stream" } });
      } });
      relays.push(relay);
      const path = join(directory, "settings.json");
      paths.push(path);
      await writeFile(path, JSON.stringify({ port: Number(new URL(relay.baseUrl).port), token }));
      const response = await fetch(relay.baseUrl + "/responses/compact", { method: "POST",
        body: JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "xhigh" } }) });
      expect(response.ok).toBe(true);
      await response.text();
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0], profile_settings: { second: paths[1] } }));
    const reader = new CompactionStatusReader(root);
    expect((await reader.status()).recent).toHaveLength(2);
    const observer = new ModelNotifications(service.storage, service.alerts);
    observer.observe(reader.notificationEvents(), config, "ko");
    const notifications = service.alerts.pendingAppNotifications(Date.now());
    expect(notifications).toHaveLength(2);
    expect(notifications.every(item => item.title === "Codex 압축 모델 전환")).toBe(true);
    observer.observe(reader.notificationEvents(), config, "ko");
    expect(service.alerts.pendingAppNotifications(Date.now())).toHaveLength(2);
  } finally {
    for (const relay of relays) relay.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
