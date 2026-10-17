"""Package the preserving QCareer integration. No database, environment or user files."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = (
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/tsconfig.json',
    'frontend/app/api/[...path]/route.ts',
    'frontend/app/qball/qball.css',
    'frontend/components/lumaball/brand.tsx',
    'frontend/components/lumaball/context.tsx',
    'frontend/components/lumaball/admin-panel.tsx',
    'frontend/components/lumaball/game-room.module.css',
    'frontend/components/lumaball/game-room.tsx',
    'frontend/components/lumaball/lobby.tsx',
    'frontend/components/lumaball/map-settings.tsx',
    'frontend/components/lumaball/map-settings.module.css',
    'frontend/components/lumaball/room-settings.tsx',
    'frontend/components/lumaball/original-lobby.css',
    'frontend/components/lumaball/shell.tsx',
    'frontend/lib/lumaball/engine.ts',
    'frontend/lib/lumaball/maps.ts',
    'frontend/lib/lumaball/types.ts',
    'frontend/types/lumaball.ts',
    'frontend/lib/lumaball/room-state.ts',
    'frontend/lib/lumaball/render.ts',
    'frontend/lib/lumaball/snapshot-interpolator.ts',
    'frontend/lib/lumaball-snapshots.test.mjs',
    'frontend/lib/lumaball-render.test.mjs',
    'frontend/lib/lumaball.test.mjs',
    'frontend/lib/lumaball-maps.test.mjs',
    'frontend/lib/lumaball-parity.test.mjs',
    'frontend/lib/lumaball-room-state.test.mjs',
    'frontend/lib/fixtures/lumaball-original/provenance.json',
    'frontend/lib/fixtures/lumaball-original/utils-game.ts.txt',
    'frontend/lib/fixtures/lumaball-original/utils-player.ts.txt',
    'frontend/lib/fixtures/lumaball-original/utils-map.ts.txt',
    'frontend/lib/fixtures/lumaball-original/utils-config_game.ts.txt',
    'frontend/lib/fixtures/lumaball-original/utils-timer.ts.txt',
    'frontend/lib/fixtures/lumaball-original/utils-utils.ts.txt',
    'frontend/lib/fixtures/lumaball-original/types-player.ts.txt',
    'frontend/lib/game-csp.mjs',
    'frontend/lib/game-csp.test.mjs',
    'frontend/lib/lumaball/session-queue.ts',
    'frontend/lib/lumaball-session.test.mjs',
    'frontend/lib/native-server.integration.mjs',
    'frontend/server.mjs',
    'scripts/launcher/data.py',
    'scripts/tests/qball_physics_fixture.mjs',
    'scripts/tests/lumaball_stack.py',
    'backend/app/lumaball_room_models.py',
    'backend/app/main.py',
    'backend/app/routers/lumaball_rooms.py',
    'backend/app/services/lumaball_identity.py',
    'backend/app/services/lumaball_rooms.py',
    'backend/app/services/lumaball_realtime.py',
    'backend/tests/test_lumaball_identity.py',
    'backend/tests/test_lumaball_realtime.py',
    'backend/tests/test_lumaball_relay_performance.py',
    'backend/tests/test_lumaball_rooms.py',
    'README.md',
    'docs/qcareer-api.md',
    'docs/qcareer.md',
    'docs/accounts.md',
    'backend/app/routers/auth_routes.py',
    'backend/app/routers/academic.py',
    'backend/tests/test_registration_groups.py',
    'backend/tests/test_security.py',
    'backend/tests/smoke_bff.py',
    'frontend/components/auth-form.tsx',
    'frontend/components/identity-shell.tsx',
    'frontend/components/identity.module.css',
    'frontend/lib/identity-brand.ts',
    'frontend/public/brand/qid-placeholder.svg',
    'frontend/components/recovery-form.tsx',
    'frontend/app/login/page.tsx',
    'frontend/app/register/page.tsx',
    'frontend/app/forgot-password/page.tsx',
    'frontend/app/reset-password/page.tsx',
    'docs/host-update.md',
    'frontend/app/dashboard/modules/page.tsx',
    'frontend/app/dashboard/syllabi/page.tsx',
    'frontend/app/dashboard/profile/page.tsx',
    'backend/app/career_models.py',
    'backend/app/routers/career.py',
    'backend/app/services/career.py',
    'backend/app/routers/branding.py',
    'backend/app/services/branding.py',
    'backend/tests/test_branding.py',
    'backend/tests/test_career.py',
    'frontend/app/dashboard/admin/page.tsx',
    'frontend/app/dashboard/layout.tsx',
    'frontend/app/dashboard/tests/page.tsx',
    'frontend/app/design.css',
    'frontend/app/developers/page.tsx',
    'frontend/app/page.tsx',
    'frontend/components/academic.tsx',
    'frontend/components/branding-provider.tsx',
    'frontend/lib/auth-return.test.mjs',
    'frontend/lib/auth-return.ts',
    'frontend/lib/auth.tsx',
    'frontend/lib/assessment-link.test.mjs',
    'frontend/lib/assessment-link.ts',
    'frontend/lib/career.test.mjs',
    'frontend/lib/career.ts',
    'frontend/public/brand/qcareer-placeholder.svg',
    'frontend/public/brand/qforcelogo_qcareer.png',
    'assets/brand/source/qforcelogo_qcareer.png',
    'frontend/types/career.ts',
    'scripts/tests/career_stack.py',
    'frontend/app/qcareer/layout.tsx',
    'frontend/app/qcareer/page.tsx',
    'frontend/app/qcareer/workspace/page.tsx',
    'frontend/app/dashboard/admin/career/page.tsx',
    'frontend/components/career/workspace.tsx',
    'frontend/components/career/shell.tsx',
    'frontend/components/career/nav-link.tsx',
    'frontend/components/career/nav-link.module.css',
    'frontend/components/career/context.tsx',
    'frontend/components/career/career.module.css',
    'frontend/components/career/brand.tsx',
    'frontend/components/career/admin.module.css',
    'frontend/components/career/admin-panel.tsx',
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
README = '''QStudy / QCareer: общий вход, учебные навыки и карьерный путь

1. Распакуйте СОДЕРЖИМОЕ этого ZIP в существующую папку QStudy на Windows
   рядом с Start-QStudy-Internet.cmd. Появятся Apply-QBall-Fix.cmd и .qstudy-fix.
   Название кнопки техническое: этот пакет добавляет QCareer и сохраняет QBall.
2. Дважды щёлкните Apply-QBall-Fix.cmd от того же пользователя Windows,
   которым запускали сайт. Дополнительные команды не нужны.
3. Дождитесь сборки и повторного запуска прежнего режима сайта.
4. Обновите страницы через Ctrl+F5. QCareer доступен по /qcareer,
   личный путь — /qcareer/workspace, управление — /dashboard/admin/career.

Пакет содержит только проверенные исходники. База, аккаунты, пароли, .env,
документы, личные материалы и сохранённые логотипы не входят в этот ZIP
и не заменяются. Импорт резервной копии не нужен. Сайт и активные комнаты
штатно останавливаются на время обновления. Изменяемые исходники сохраняются
в закрытой папке .local/source-updates. Автоматического отката данных нет.
Чужие процессы и запуски другого пользователя Windows не завершаются.

QCareer использует существующий вход и роли QStudy, общую базу и общий запуск.
При старте добавляются только таблицы career_*. Учебный каталог создаётся
один раз, без демонстрационных сотрудников или чужих аккаунтов.
Удалённые администратором навыки не создаются повторно при перезапуске.

Вход, регистрация и восстановление пароля оформлены под общим брендом Q-ID
для QStudy, QCareer и QBall. Все текущие аккаунты и пароли продолжают работать:
повторная регистрация или сброс аккаунтов не нужны. Выбор учебной группы
при регистрации и назначение группы через админку сохранены.
Восстановление пароля использует прежнюю общую базу и настройки почты.
Временный логотип Q-ID можно заменить, когда будет готов основной логотип.
Пошаговое обновление действующего хоста описано в docs/host-update.md.

Навыки связаны с силабусами, дисциплинами, модулями, неделями и работами.
Подтверждение рассчитывается по завершённым тестам учебной программы
и оценённым администратором работам. Личные отметки «изучено» не начисляют
подтверждённые уровни. Карьерные направления показывают покрытие требований,
варианты профессий и продолжения образования. План предлагает до трёх шагов
с учётом предварительных навыков. Возможности публикует администратор:
стажировки, работа, учебные программы и курсы со ссылками на источники.

В админке доступны создание, изменение и удаление каталога, направлений,
требований, учебных связей и предложений; обзор групп и результатов студентов;
предложения автоматических связей с предварительным просмотром; настройки
и загрузка своего PNG-логотипа с прозрачным фоном. Оформление — оранжевое.

Сохранены исправления QBall: карты, оригинальная физика классического футбола,
сглаживание отрисовки, гостевой вход, приглашения и единая база QStudy.
Подробности работы QCareer: docs/qcareer.md; контракт: docs/qcareer-api.md.
'''


def build(output: Path, mode: str) -> dict:
    assert 1 <= len(PAYLOAD) <= 128 and len(PAYLOAD) == len(set(PAYLOAD))
    contents = {path: (ROOT / path).read_bytes() for path in PAYLOAD}
    assert all(len(value) <= 4 * 1024 * 1024 for value in contents.values())
    assert sum(map(len, contents.values())) <= 32 * 1024 * 1024
    files = [{'path': path, 'sha256': hashlib.sha256(contents[path]).hexdigest()}
             for path in PAYLOAD]
    identifier = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:12]
    manifest = {'version': 1, 'id': 'qcareer-integration-' + identifier,
                'target_mode': mode, 'files': files}
    entries = {
        'Apply-QBall-Fix.cmd': WRAPPER,
        '.qstudy-fix/README.txt': README.encode('utf-8-sig'),
        '.qstudy-fix/manifest.json': json.dumps(manifest, ensure_ascii=True, indent=2).encode(),
        '.qstudy-fix/Apply.ps1': (ROOT / 'scripts/maintenance/Apply-QCareerFix.ps1').read_bytes(),
    }
    for path in PAYLOAD:
        entries['.qstudy-fix/payload/' + path] = contents[path]
    for path in STOP_HELPERS:
        entries['.qstudy-fix/stop/' + path] = (ROOT / path).read_bytes()
    assert 4 <= len(entries) <= 200
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 17, 0, 0, 0))
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
    parser.add_argument('--output', type=Path, default=ROOT / 'assets/distribution/QStudy-QCareer-Integration.zip')
    parser.add_argument('--mode', choices=('local', 'lan', 'internet'), default='internet')
    options = parser.parse_args()
    print(json.dumps(build(options.output, options.mode)))
