import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("desktop configuration install and rollback preserve unrelated settings and edits", async () => {
  const code = `
import importlib.util, pathlib, tomllib
spec = importlib.util.spec_from_file_location('relay', pathlib.Path('scripts/codex-compaction-local.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
original = '# Personal settings\\nmodel = "gpt-6-astra"\\n[features]\\njs_repl = false\\n'
url = 'http://127.0.0.1:1234/private/backend-api/codex'
enabled = m.enabled_config(original, url)
assert tomllib.loads(enabled)['openai_base_url'] == url
assert m.enabled_config(enabled, url) == enabled
assert m.strip_managed_config(enabled) == original
edit = '\\n[desktop]\\nmode = "changed while enabled"\\n'
assert m.strip_managed_config(enabled + edit) == original + edit
for conflict in ['openai_base_url = "https://example.org"\\n', 'model_provider = "custom"\\n']:
    try: m.enabled_config(conflict, url)
    except ValueError: pass
    else: raise AssertionError('Existing endpoint/provider replaced')
for malformed in [enabled + m.BEGIN, '# moved\\n' + enabled, enabled.replace(m.END, 'unrelated = true\\n' + m.END)]:
    try: m.strip_managed_config(malformed)
    except ValueError: pass
    else: raise AssertionError('Edited managed block removed')
`;
  const process = Bun.spawn(["python3", "-B", "-c", code], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  expect(await new Response(process.stderr).text()).toBe("");
  expect(await process.exited).toBe(0);
});
