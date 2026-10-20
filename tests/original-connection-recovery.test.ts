import { test, expect } from "bun:test";
test("offline original connection recovery preserves settings and handles failed writes", async () => {
  const process = Bun.spawn(["python3", "-B", "tests/original_connection_recovery.py"], {stdout:"pipe",stderr:"pipe"});
  const [code, out, error] = await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:""});
  expect(out).toContain("4 offline recovery/backup/rollback scenarios passed");
});
