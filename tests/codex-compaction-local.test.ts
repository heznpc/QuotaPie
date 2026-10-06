import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("profile-scoped disable restores only the affected account and preserves other relays", async () => {
  const code = `
import importlib.util, pathlib, tempfile, json, types, tomllib
spec = importlib.util.spec_from_file_location('relay', pathlib.Path('scripts/codex-compaction-local.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    entries = []
    for index in range(2):
        home = root / str(index)
        home.mkdir()
        settings = {'codex_home': str(home), 'port': 12000 + index, 'token': 'a' * 48,
                    'route': {'from': 'gpt-6-astra', 'to': 'gpt-5.6-sol', 'effort': 'low'},
                    'taskSavings': {'enabled': True}}
        text = json.dumps(settings)
        path = home / 'settings.json'
        path.write_text(text)
        config = m.enabled_config('model = "gpt-6-astra"\\n[features]\\njs_repl = false\\n', m.LocalRelay.endpoint(settings))
        (home / 'config.toml').write_text(config)
        entries.append((path, text, settings))
    primary_config = (root / '0/config.toml').read_bytes()
    primary_settings = entries[0][0].read_bytes()
    manager = m.LocalRelay.__new__(m.LocalRelay)
    manager.settings_path = entries[0][0]
    manager.registered_entries = lambda: [(path, path.read_text(), json.loads(path.read_text())) for path, _, _ in entries]
    manager.settings = lambda: json.loads(manager.settings_path.read_text())
    checks = []
    manager.health = lambda settings: checks.append(settings['codex_home'])
    result = manager.disable(types.SimpleNamespace(codex_home=str(root / '1')))
    assert result['configured'] is False and result['restart_required'] is True
    assert checks == [str(root / '1')]
    assert (root / '0/config.toml').read_bytes() == primary_config
    assert entries[0][0].read_bytes() == primary_settings
    restored = tomllib.loads((root / '1/config.toml').read_text())
    assert 'openai_base_url' not in restored
    assert restored['features']['js_repl'] is False
    changed = json.loads(entries[1][0].read_text())
    assert changed['route']['to'] == changed['route']['from']
    assert changed['taskSavings']['enabled'] is False
    before = entries[1][0].read_bytes()
    try:
        manager.disable(types.SimpleNamespace(codex_home=str(root / 'missing')))
    except ValueError:
        pass
    else:
        raise AssertionError('Unknown profile accepted')
    assert entries[1][0].read_bytes() == before
    # The existing no-argument command still disables all registered profiles.
    manager.disable()
    assert 'openai_base_url' not in tomllib.loads((root / '0/config.toml').read_text())
    assert json.loads(entries[0][0].read_text())['taskSavings']['enabled'] is False
`;
  const process = Bun.spawn(["python3", "-B", "-c", code], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const error = await new Response(process.stderr).text();
  expect(error).toBe("");
  expect(await process.exited).toBe(0);
});

test("candidate installation failures retain the old endpoint and unrelated concurrent edits", async () => {
  const process = Bun.spawn(["python3", "-B", "tests/compaction_install_transaction.py"], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  expect(await new Response(process.stderr).text()).toBe("");
  expect(await process.exited).toBe(0);
});

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
