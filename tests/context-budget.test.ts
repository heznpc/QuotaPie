import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native context settings preserve model, provider, auth settings and restore bytes from backup", async () => {
  const home = mkdtempSync(join(tmpdir(), "qp-context-budget-"));
  try {
    const code = `
import importlib.util,pathlib,sys,tomllib
spec=importlib.util.spec_from_file_location("budget","scripts/configure-context-budget.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
home=pathlib.Path(sys.argv[1]);path=home/"config.toml"
original=b'model = "gpt-6-astra"\\nmodel_provider = "custom"\\n# preserve comment\\n[model_providers.custom]\\nbase_url = "https://example.invalid"\\n[features]\\nexample = true\\n'
path.write_bytes(original)
result=m.configure(home);data=tomllib.loads(path.read_text())
assert data["model"]=="gpt-6-astra"
assert data["model_provider"]=="custom"
assert data["model_auto_compact_token_limit"]==96000
assert data["tool_output_token_limit"]==2000
assert pathlib.Path(result["backup"]).read_bytes()==original
assert m.configure(home)["changed"] is False
try:m.configure(home, compact=0)
except ValueError:pass
else:raise AssertionError("invalid limit accepted")
assert "# preserve comment" in path.read_text()
`;
    const process = Bun.spawn(["python3", "-B", "-c", code, home], { stdout: "pipe", stderr: "pipe" });
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
