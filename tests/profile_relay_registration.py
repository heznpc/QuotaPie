import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('relay', Path('scripts/codex-compaction-local.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
base = {'settings_path': '/primary/settings.json', 'retired_settings': ['/older/settings.json']}
one = m.updated_manifest(base, '/second/settings.json', '/second-home', '/primary-home')
assert one['settings_path'] == base['settings_path']
assert one['profile_settings'] == {'/second-home': '/second/settings.json'}
two = m.updated_manifest(one, '/second-new/settings.json', '/second-home', '/primary-home')
assert '/second/settings.json' in two['retired_settings']
assert set(m.registered_settings(two)) == {'/primary/settings.json','/older/settings.json','/second/settings.json','/second-new/settings.json'}
three = m.updated_manifest(two, '/primary-new/settings.json', '/primary-home', '/primary-home')
assert three['profile_settings'] == two['profile_settings']
assert three['settings_path'] == '/primary-new/settings.json'
assert base == {'settings_path': '/primary/settings.json', 'retired_settings': ['/older/settings.json']}

with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp)
    relay=object.__new__(m.LocalRelay)
    paths=[]
    for i in range(2):
        home=root/str(i);home.mkdir()
        settings={'port':45000+i,'token':str(i)*48,'codex_home':str(home),'route':{'from':'gpt-6-astra','to':'gpt-5.6-sol','effort':'low'}}
        settings['taskSavings']={'enabled':True,'model':'gpt-5.6-luna','effort':'low'}
        path=home/'settings.json';path.write_text(json.dumps(settings));paths.append(str(path))
        (home/'config.toml').write_text(m.enabled_config('model = "gpt-6-astra"\n',m.LocalRelay.endpoint(settings)))
    relay.settings_path=Path(paths[0]);relay.manifest={'settings_path':paths[0],'profile_settings':{str(root/'1'):paths[1]}}
    relay.health=lambda s: {'service':'quotapie-compaction','schemaVersion':3,'route':s['route']}
    relay.install=lambda args: (_ for _ in ()).throw(AssertionError('duplicate generation installed'))
    assert relay.ensure_profile(SimpleNamespace(codex_home=str(root/'1')))['relayConnected']
    try:relay.stop()
    except RuntimeError:pass
    else:raise AssertionError('stopped a configured profile')
    relay.disable()
    for i in range(2):
        assert tomllib.loads((root/str(i)/'config.toml').read_text()) == {'model':'gpt-6-astra'}
        saved=json.loads(Path(paths[i]).read_text());assert saved['route']['to']==saved['route']['from']
        assert saved['taskSavings']['enabled'] is False
    assert relay.ensure_profile(SimpleNamespace(codex_home=str(root/'1'))) == {'relayConnected':False}
