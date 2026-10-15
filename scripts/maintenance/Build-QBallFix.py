"""Package a source-only Windows fix. No database, environment or user files."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = (
    'frontend/app/api/[...path]/route.ts',
    'frontend/app/qball/qball.css',
    'frontend/components/lumaball/brand.tsx',
    'frontend/components/lumaball/context.tsx',
    'frontend/components/lumaball/game-room.module.css',
    'frontend/components/lumaball/game-room.tsx',
    'frontend/components/lumaball/lobby.tsx',
    'frontend/components/lumaball/original-lobby.css',
    'frontend/components/lumaball/shell.tsx',
    'frontend/lib/lumaball/render.ts',
    'frontend/lib/lumaball/snapshot-interpolator.ts',
    'frontend/lib/lumaball-snapshots.test.mjs',
    'frontend/lib/lumaball-render.test.mjs',
    'frontend/lib/game-csp.mjs',
    'frontend/lib/game-csp.test.mjs',
    'frontend/lib/lumaball/session-queue.ts',
    'frontend/lib/lumaball-session.test.mjs',
    'frontend/lib/native-server.integration.mjs',
    'frontend/server.mjs',
    'scripts/launcher/data.py',
    'backend/app/services/lumaball_realtime.py',
)
STOP_HELPERS = (
    'scripts/launcher/Stop-Previous.ps1', 'scripts/launcher/Native.ps1',
    'scripts/QStudy.Common.ps1', 'scripts/QStudy.Install.ps1',
    'scripts/QStudy.DetachedProcess.cs', 'scripts/launcher_network.ps1',
    'scripts/QStudy.HomeNetwork.ps1', 'scripts/production/QStudy.WindowsHost.ps1',
    'scripts/production/QStudy.PortMapping.ps1',
)
WRAPPER = '''@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0.qstudy-fix\\Apply.ps1" -Root "%~dp0." %*
exit /b %errorlevel%
'''.replace('\n', '\r\n').encode('ascii')
README = '''QStudy / QBall: плавность игры и исходный интерфейс комнат

1. Распакуйте СОДЕРЖИМОЕ ZIP в существующую папку работающего QStudy
   на Windows-хосте рядом с Start-QStudy-Internet.cmd.
   Появятся Apply-QBall-Fix.cmd и папка .qstudy-fix.
2. Дважды щёлкните Apply-QBall-Fix.cmd от того же пользователя Windows,
   которым запускали сайт. Команды вводить не нужно.
3. Дождитесь сообщения об установленном исправлении и запущенном сайте.
   При запросе Windows подтвердите правило сети QStudy.
4. На обоих устройствах обновите страницы через Ctrl+F5 и откройте QBall.
   Создайте комнату и отправьте ссылку из «Пригласить друга».

Помощник проверяет пакет, штатно останавливает эту установку, сохраняет
изменяемые исходники, обновляет интерфейс, игровой сетевой канал и запись статуса,
затем запускает прежний режим.
База, аккаунты, документы, логотипы в базе, .env, ключи и пароли не входят
в этот ZIP и не заменяются. Импорт резервной копии не нужен.
Во время обновления сайт и активные комнаты будут остановлены.
Если проверка владельца или запуска не прошла, окно объяснит причину;
чужие процессы автоматически не завершаются.

Вкладку создателя оставляйте открытой. «Комнаты» и справочные ссылки
из активной игры открываются отдельно. «Выйти из комнаты» у создателя
закрывает её для всех — перед этим показывается предупреждение.

Картинка создателя обновляется на каждом кадре браузера независимо от сети.
Для остальных игроков сглаживаются сетевые снимки; передача ограничена
30 снимками в секунду, управление отправляется сразу при нажатии клавиш.
Восстановлены компактная таблица комнат и меню команд исходного LumaBall.
'''


def build(output: Path, mode: str) -> dict:
    files = [{'path': path, 'sha256': hashlib.sha256((ROOT / path).read_bytes()).hexdigest()}
             for path in PAYLOAD]
    identifier = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:12]
    manifest = {'version': 1, 'id': 'qball-browser-' + identifier,
                'target_mode': mode, 'files': files}
    entries = {
        'Apply-QBall-Fix.cmd': WRAPPER,
        '.qstudy-fix/README.txt': README.encode('utf-8-sig'),
        '.qstudy-fix/manifest.json': json.dumps(manifest, ensure_ascii=True, indent=2).encode(),
        '.qstudy-fix/Apply.ps1': (ROOT / 'scripts/maintenance/Apply-QBallFix.ps1').read_bytes(),
    }
    for path in PAYLOAD:
        entries['.qstudy-fix/payload/' + path] = (ROOT / path).read_bytes()
    for path in STOP_HELPERS:
        entries['.qstudy-fix/stop/' + path] = (ROOT / path).read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 16, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None and set(archive.namelist()) == set(entries)
        assert all(not Path(name).name.startswith('.env') and
                   not name.endswith(('.db', '.sqlite3', '.sqlite', '.pem', '.key'))
                   for name in archive.namelist())
        for entry in files:
            assert hashlib.sha256(archive.read('.qstudy-fix/payload/' + entry['path'])).hexdigest() == entry['sha256']
    return {'archive': str(output.resolve()), 'source_files': len(files), 'bytes': output.stat().st_size,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'contains_private_data': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/handover/QStudy-QBall-Browser-Fix.zip')
    parser.add_argument('--mode', choices=('local', 'lan', 'internet'), default='internet')
    options = parser.parse_args()
    print(json.dumps(build(options.output, options.mode)))
