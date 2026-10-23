import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path('scripts/restore-original-connection.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

for scenario in ['success', 'edited', 'second-write-fails', 'concurrent-edit']:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        runtime = root / 'runtime'; runtime.mkdir()
        paths, settings, originals = [], [], []
        for i in range(2):
            home = root / str(i); home.mkdir()
            path = home / 'config.toml'
            setting = {'codex_home':str(home),'port':45001+i,'token':'fixture','route':{'from':'native','to':'native'}}
            settings_path = runtime / f'{i}.json'; settings_path.write_text(json.dumps(setting)); settings.append(str(settings_path))
            text = m.manager.enabled_config('model = "gpt-6-astra"\n# user settings\n',m.manager.LocalRelay.endpoint(setting))
            path.write_text(text); paths.append(path); originals.append(text)
        (runtime / 'current.json').write_text(json.dumps({'settings_path':settings[0],'profile_settings':{'second':settings[1]}}))
        before_settings = [Path(p).read_bytes() for p in settings]
        if scenario == 'edited':
            paths[1].write_text(originals[1].replace('45002','45003'))
        atomic = m.manager.atomic_write
        def write(path,text,**kwargs):
            if path == paths[1] and scenario in ['second-write-fails','concurrent-edit']:
                if scenario == 'concurrent-edit': paths[0].write_text(paths[0].read_text()+'# concurrent edit\n')
                raise OSError('synthetic failure')
            return atomic(path,text,**kwargs)
        with patch.object(m.manager,'atomic_write',write), patch.object(m.manager.LocalRelay,'health',side_effect=AssertionError('must work offline')):
            try:
                result=m.restore(runtime,root/'backups')
                assert scenario == 'success', (scenario,result)
                for path in paths:
                    assert path.read_text() == 'model = "gpt-6-astra"\n# user settings\n'
                backup=Path(result['backupPath'])
                assert result['changed']==2
                for i in range(2): assert (backup/f'config-{i}.toml').read_text()==originals[i]
            except RuntimeError:
                assert scenario != 'success'
        assert [Path(p).read_bytes() for p in settings]==before_settings, 'live listener settings must stay intact'
        if scenario in ['edited','second-write-fails']: assert paths[0].read_text()==originals[0]
        if scenario=='second-write-fails': assert paths[1].read_text()==originals[1]
        if scenario=='concurrent-edit': assert paths[0].read_text().endswith('# concurrent edit\n')
print('4 offline recovery/backup/rollback scenarios passed')
