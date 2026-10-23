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
original=b'model = "gpt-6-astra"\\nmodel_provider = "custom"\\nmodel_auto_compact_token_limit_scope = "total"\\n# preserve comment\\n[model_providers.custom]\\nbase_url = "https://example.invalid"\\n[features]\\nexample = true\\n'
path.write_bytes(original)
result=m.configure(home);data=tomllib.loads(path.read_text())
assert data["model"]=="gpt-6-astra"
assert data["model_provider"]=="custom"
assert data["model_auto_compact_token_limit"]==96000
assert data["model_auto_compact_token_limit_scope"]=="body_after_prefix"
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

test("coordination rules cover existing profiles once, preserve symlinks and unrelated instructions", async () => {
  const home = mkdtempSync(join(tmpdir(), "qp-agent-budget-"));
  try {
    const code = `
import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location("budget","scripts/configure-context-budget.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[1]).resolve();home=root/"native";home.mkdir()
shared=root/"shared.md";original=b"# Existing rules\\nKeep model and reasoning unchanged.\\n";shared.write_bytes(original)
(home/"AGENTS.md").symlink_to(shared)
profiles=root/"profiles";profile=profiles/"one"/"home";profile.mkdir(parents=True)
(profile/"config.toml").write_text('model = "gpt-6-astra"\\n')
(profiles/"retired").mkdir()
alias=root/"alias";alias.symlink_to(home,target_is_directory=True)
assert m.target_homes([home,alias],profiles)==sorted([home,profile])
for target in m.target_homes([home],profiles):
    result=m.configure_agent_policy(target)
    assert result["changed"]
    assert m.configure_agent_policy(target)["changed"] is False
    content=(target/"AGENTS.md").read_text()
    assert content.count(m.POLICY_START)==1
    assert 'followup_task' in content and 'wait_agent' in content
    if target==home: assert pathlib.Path(result["backup"]).read_bytes()==original
assert (home/"AGENTS.md").is_symlink()
assert shared.read_bytes().startswith(original)
assert not (profiles/"retired"/"home").exists()
broken=profile/"AGENTS.md";broken.write_text(m.POLICY_START)
try:m.configure_agent_policy(profile)
except ValueError:pass
else:raise AssertionError("malformed block overwritten")
assert broken.read_text()==m.POLICY_START
`;
    const process = Bun.spawn(["python3", "-B", "-c", code, home], { stdout: "pipe", stderr: "pipe" });
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
