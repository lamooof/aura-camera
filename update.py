#!/usr/bin/env python3
"""Offline update of an existing Aura Camera 0.4.0/0.4.1 installation to 0.4.2.

Preserves downloaded models, libraries, cache, Chrome extension path and settings.
Creates a reversible backup before modifying any file. Python standard library only.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = '0.4.2'


def checked_path(root: Path, relative: str) -> Path:
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Путь выходит за папку расширения: ' + relative)
    return path


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.aura-update-part')
    try:
        temporary.write_bytes(data)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def restore(target: Path, backup: Path) -> None:
    info = json.loads((backup / 'backup.json').read_text(encoding='utf-8'))
    if Path(info['target']).resolve() != target.resolve():
        raise ValueError('Резервная копия относится к другой папке')
    for relative, existed in info['files'].items():
        path = checked_path(target, relative)
        if existed:
            atomic_write(path, checked_path(backup / 'files', relative).read_bytes())
        elif path.exists():
            path.unlink()


def update(target: Path) -> Path:
    target = target.expanduser().resolve()
    if target.name == 'extension' and (target/'manifest.json').exists():
        target = target.parent
    ext = target/'extension'
    if target == ROOT:
        raise ValueError('Нужна СТАРАЯ установленная папка, а не папка нового архива')
    manifest = json.loads((ext/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version') not in ('0.4.0','0.4.1') or not manifest.get('name','').startswith('Aura Camera'):
        raise ValueError('Этот установщик обновляет Aura Camera 0.4.0 или 0.4.1')
    lock = json.loads((target/'DEPENDENCIES.lock.json').read_text(encoding='utf-8'))
    if not lock.get('installed',{}).get('fast'):
        raise ValueError('В старой папке нет быстрой модели. Сначала выполните там: python3 prepare.py --models fast')
    for relative,digest in lock['files'].items():
        path = checked_path(ext,relative)
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Зависимость отсутствует или изменена: '+relative+'. Обновление не начато.')
    changes = {}
    for pattern in ['*.js','*.html','*.css','manifest.json','native/*.wasm']:
        for src in (ROOT/'extension').glob(pattern):
            if src.name == 'build-info.js':
                continue
            changes['extension/'+str(src.relative_to(ROOT/'extension'))] = src.read_bytes()
    for name in ['prepare.py','update.py','README.md','README.html','TEST_REPORT.md','TEST_REPORT.html','CHANGELOG.md','VIDEO_REVIEW.md','VIDEO_REVIEW.html','PRIVACY.md','THIRD_PARTY_NOTICES.md','INTERFACE.png']:
        src=ROOT/name
        if src.is_file():
            changes[name]=src.read_bytes()
    for folder, patterns in [('native',['*.c','*.py','*.json']),('tests',['*.py','*.cjs','*.json','*.txt'])]:
        for pattern in patterns:
            for src in (ROOT/folder).glob(pattern):
                changes[folder+'/'+src.name] = src.read_bytes()
    lock['version']=VERSION
    changes['DEPENDENCIES.lock.json'] = (json.dumps(lock,indent=2,ensure_ascii=False)+'\n').encode()
    build={'version':VERSION,'prepared':True,'installed':lock['installed']}
    changes['extension/build-info.js'] = ('globalThis.AuraBuild = Object.freeze('+json.dumps(build,ensure_ascii=False)+');\n').encode()
    for relative in changes:
        checked_path(target,relative)
    # All source reads and validation occur before backup or writes to the target.
    backup = target/'.backups'/(manifest['version']+'-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    backup.mkdir(parents=True)
    records={}
    for relative in changes:
        old=target/relative;records[relative]=old.is_file()
        if old.is_file():
            path=backup/'files'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(old.read_bytes())
    (backup/'backup.json').write_text(json.dumps({'target':str(target),'files':records},indent=2,ensure_ascii=False),encoding='utf-8')
    try:
        for relative,data in changes.items():
            atomic_write(target/relative,data)
    except BaseException:
        restore(target,backup)
        raise
    return backup


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',type=Path,help='Папка старой Aura Camera (с prepare.py или extension/manifest.json)')
    parser.add_argument('--rollback',type=Path,help='Вернуть файлы из резервной копии этого установщика')
    args=parser.parse_args()
    try:
        if args.rollback:
            backup=args.rollback.expanduser().resolve()
            info=json.loads((backup/'backup.json').read_text(encoding='utf-8'))
            target=Path(info['target'])
            restore(target,backup)
            print('Файлы восстановлены. Перезагрузите Aura Camera в chrome://extensions и страницы звонков.')
        else:
            target=args.target
            if target is None:
                entered=input('Путь к УСТАНОВЛЕННОЙ папке Aura Camera 0.4.0/0.4.1 (где prepare.py): ').strip().strip('"\'')
                if not entered:
                    raise ValueError('Путь не указан; ничего не изменено')
                target=Path(entered)
            backup=update(target)
            print('Готово: Aura Camera 0.4.2 установлена в прежнюю папку.')
            print('Модели и библиотеки сохранены. Скачиваний не было.')
            print('Резервная копия: '+str(backup))
            print('В chrome://extensions нажмите ↻ на ПРЕЖНЕЙ Aura Camera, затем обновите страницу звонка.')
            print('Откройте «Контур, глубина и диагностика» → «Уменьшить мерцание». Остальные настройки сохраняются.')
        return 0
    except (Exception,KeyboardInterrupt) as e:
        print('ОБНОВЛЕНИЕ НЕ ЗАВЕРШЕНО: '+str(e),file=sys.stderr)
        return 1

if __name__=='__main__':
    raise SystemExit(main())
