"""打包云函数；显式保留 Linux 启动文件的可执行权限与 LF 换行。"""
import json
import stat
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
destination = root / 'output' / 'backend'
destination.mkdir(parents=True, exist_ok=True)
result = []
for function_name in ('swap-api', 'swap-maintenance'):
    folder = root / 'cloudfunctions' / function_name
    target = destination / f'{function_name}.zip'
    names = ['index.js', 'package.json'] + (['scf_bootstrap'] if function_name == 'swap-api' else [])
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (folder / name).read_bytes()
            if name == 'scf_bootstrap':
                data = data.replace(b'\r\n', b'\n')
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            permissions = 0o755 if name == 'scf_bootstrap' else 0o644
            info.external_attr = (stat.S_IFREG | permissions) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    result.append({'function': function_name, 'bytes': target.stat().st_size, 'path': str(target)})
print(json.dumps(result))
