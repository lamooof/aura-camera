#!/usr/bin/env python3
"""Prepare local Aura Camera dependencies. Python 3.10+, standard library only.

No sudo, pip, Node.js, shell commands or execution of downloaded Python code.
--all downloads all five processing options. Without it: two MediaPipe options.
All executable JS/WASM is packaged locally before Chrome loads it.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import re
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT / 'extension'
MP_VERSION = '0.10.21'
ORT_VERSION = '1.22.0'
MAX_DOWNLOAD = 256 * 1024 * 1024
ALLOWED_HOSTS = {'registry.npmjs.org', 'storage.googleapis.com', 'github.com',
                 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
                 'raw.githubusercontent.com'}
MODELS = {
    'fast': ('selfie_segmenter_landscape.tflite',
        'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite'),
    'multiclass': ('selfie_multiclass_256x256.tflite',
        'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'),
    'rvm': ('rvm_mobilenetv3_fp32.onnx',
        'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx'),
    'modnet': ('modnet_webcam.onnx',
        'https://github.com/yakhyo/modnet/releases/download/weights/modnet_webcam.onnx'),
    'depth': ('midas_small.onnx',
        'https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx')
}
MP_FILES = ['vendor/vision.bundle.js', 'vendor/wasm-loader.js', 'vendor/vision_wasm_internal.wasm']
ORT_FILES = ['vendor/ort.all.min.js', 'vendor/ort-wasm-simd-threaded.jsep.mjs',
             'vendor/ort-wasm-simd-threaded.jsep.wasm']

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def validate_url(url: str) -> None:
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.hostname not in ALLOWED_HOSTS or p.username or p.password:
        raise ValueError('Непредусмотренный адрес загрузки: ' + url)

OPENER = urllib.request.build_opener(SafeRedirect())

def download(url: str, maximum: int = MAX_DOWNLOAD) -> bytes:
    validate_url(url)
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'AuraCameraSetup/0.4.2', 'Accept-Encoding':'identity'})
            with OPENER.open(req, timeout=90) as response:
                if response.status != 200:
                    raise RuntimeError(f'HTTP {response.status}')
                output = bytearray()
                while chunk := response.read(1024 * 1024):
                    output.extend(chunk)
                    if len(output) > maximum:
                        raise RuntimeError('Размер загрузки превышает лимит')
                if not output:
                    raise RuntimeError('Получен пустой файл')
                return bytes(output)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
            if attempt < 2:
                print(f'  Повтор {attempt+2}/3…', flush=True)
                time.sleep(attempt+1)
    raise RuntimeError(f'Не удалось скачать {url}\n{last}')

def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name+'.part')
    temp.write_bytes(data)
    temp.replace(path)

def cached(cache: Path, name: str, url: str, maximum: int = MAX_DOWNLOAD) -> bytes:
    target = cache / name
    if not target.is_file():
        atomic_write(target, download(url, maximum))
    data = target.read_bytes()
    if not data or len(data) > maximum:
        raise ValueError('Повреждённый кэш: ' + str(target))
    return data

def npm_package(cache: Path, name: str, version: str) -> tuple[tarfile.TarFile, str]:
    escaped = urllib.parse.quote(name, safe='@')
    short = name.rsplit('/', 1)[-1]
    meta = json.loads(cached(cache, f'{short}-{version}.json', f'https://registry.npmjs.org/{escaped}/{version}', 3*1024*1024))
    if meta.get('name') != name or meta.get('version') != version:
        raise ValueError('Неверные метаданные npm')
    integrity = meta.get('dist', {}).get('integrity', '')
    if not integrity.startswith('sha512-'):
        raise ValueError('В npm нет SHA-512')
    url = f'https://registry.npmjs.org/{name}/-/{short}-{version}.tgz'
    data = cached(cache, f'{short}-{version}.tgz', url)
    actual = 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
    if integrity != actual:
        raise ValueError('Контрольная сумма npm не совпала: '+short+'. Удалите только этот файл из .cache и повторите.')
    return tarfile.open(fileobj=io.BytesIO(data), mode='r:gz'), integrity

def read_member(tar: tarfile.TarFile, relative: str) -> bytes:
    info = tar.getmember('package/'+relative)
    if not info.isfile() or info.size > MAX_DOWNLOAD:
        raise ValueError('Недопустимый элемент архива: '+relative)
    f = tar.extractfile(info)
    if f is None:
        raise ValueError('Нет файла в архиве: '+relative)
    return f.read()

def adapt_bundle(source: str) -> str:
    source = re.sub(r'(?m)^//# sourceMappingURL=.*$', '', source).rstrip()
    match = re.search(r'\bexport\s*\{([^{}]+)\}\s*;?\s*$', source)
    if not match:
        raise ValueError('Неизвестный формат MediaPipe: нет экспортов')
    body = source[:match.start()]
    if re.search(r'\b(?:import|export)\s*(?:\{|\*|\()', body) or 'import.meta' in body:
        raise ValueError('Неожиданные импорты в MediaPipe')
    exports = {}
    for part in match.group(1).split(','):
        p = re.fullmatch(r'([$\w]+)(?:\s+as\s+([$\w]+))?', part.strip())
        if not p:
            raise ValueError('Неизвестный экспорт MediaPipe')
        exports[p.group(2) or p.group(1)] = p.group(1)
    if 'ImageSegmenter' not in exports:
        raise ValueError('Нет ImageSegmenter')
    return (f'/* MediaPipe {MP_VERSION}, Apache-2.0. Only export wrapper changed. */\n'
            '(() => {\n'+body+'\nglobalThis.AuraVision = Object.freeze({ImageSegmenter: '
            +exports['ImageSegmenter']+'});\n})();\n')

def adapt_loader(source: str) -> str:
    if 'ModuleFactory' not in source or re.search(r'\bexport\s+(?:default|\{)', source):
        raise ValueError('Неизвестный загрузчик MediaPipe')
    return '/* MediaPipe Emscripten loader. Static isolated-world factory wrapper. */\n(() => {\n'+source+'\nglobalThis.AuraWasmFactory = ModuleFactory;\n})();\n'

def validate_binary(data: bytes, name: str) -> None:
    if name.endswith('.wasm'):
        if len(data) < 1000000 or data[:8] != b'\0asm\1\0\0\0':
            raise ValueError('Некорректный WASM: '+name)
    elif name.endswith('.tflite'):
        if len(data) < 100000 or data[4:8] != b'TFL3':
            raise ValueError('Некорректный TFLite: '+name)
    elif name.endswith('.onnx'):
        if len(data) < 100000 or data[:1] != b'\x08':
            raise ValueError('Некорректный ONNX/получена HTML-страница: '+name)

def installed_from_files(files: dict) -> dict:
    mp = all(x in files for x in MP_FILES)
    ort = all(x in files for x in ORT_FILES)
    result = {k: 'models/'+v[0] in files and (mp if k in ('fast','multiclass') else ort) for k,v in MODELS.items()}
    result['depth'] = result['depth'] and result['multiclass']
    return result

def validate_complete() -> dict:
    path = ROOT/'DEPENDENCIES.lock.json'
    if not path.is_file():
        raise ValueError('Зависимости не подготовлены: python3 prepare.py --all')
    lock = json.loads(path.read_text(encoding='utf-8'))
    for name, expected in lock['files'].items():
        p = EXT/name
        if p.resolve().is_relative_to(EXT.resolve()) is False:
            raise ValueError('Недопустимый путь в lock')
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('Файл отсутствует или изменён: '+name)
    manifest = json.loads((EXT/'manifest.json').read_text())
    if manifest['version'] != '0.4.2':
        raise ValueError('Неверная версия манифеста')
    required = {'popup.html','preview.html','ui.js','ui.css','service-worker.js','models.js','build-info.js','selftest.js','native/refiner-simd.wasm','native/refiner.wasm'}
    for item in manifest['content_scripts']:
        required.update(item['js'])
    required.update(manifest['icons'].values())
    for p in required:
        if not (EXT/p).is_file():
            raise ValueError('Нет файла расширения: '+p)
    for name in ['native/refiner-simd.wasm','native/refiner.wasm']:
        if (EXT/name).read_bytes()[:8] != b'\0asm\1\0\0\0':
            raise ValueError('Некорректный локальный RGB-фильтр: '+name)
    if installed_from_files(lock['files']) != lock['installed']:
        raise ValueError('Несогласованный список моделей')
    expected = 'globalThis.AuraBuild = Object.freeze('+json.dumps({'version':'0.4.2','prepared':True,'installed':lock['installed']},ensure_ascii=False)+');\n'
    if (EXT/'build-info.js').read_text(encoding='utf-8') != expected:
        raise ValueError('build-info.js не соответствует lock-файлу')
    return lock

def prepare(selected: set[str], cache: Path) -> None:
    if 'depth' in selected:
        selected.add('multiclass')
    cache.mkdir(parents=True, exist_ok=True)
    files, packages = {}, {}
    previous = ROOT/'DEPENDENCIES.lock.json'
    if previous.exists():
        old = json.loads(previous.read_text())
        for name,digest in old.get('files', {}).items():
            p=EXT/name
            if p.resolve().is_relative_to(EXT.resolve()) and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==digest:
                files[name]=p.read_bytes()
        packages.update(old.get('packages',{}))
    print('Aura Camera 0.4.2 · локальная подготовка\nСистемные файлы не изменяются.', flush=True)
    if selected & {'fast','multiclass'} and not all(x in files for x in MP_FILES):
        print('[1] MediaPipe '+MP_VERSION, flush=True)
        tar, integrity = npm_package(cache,'@mediapipe/tasks-vision',MP_VERSION)
        with tar:
            files[MP_FILES[0]]=adapt_bundle(read_member(tar,'vision_bundle.mjs').decode()).encode()
            files[MP_FILES[1]]=adapt_loader(read_member(tar,'wasm/vision_wasm_internal.js').decode()).encode()
            files[MP_FILES[2]]=read_member(tar,'wasm/vision_wasm_internal.wasm')
        packages['mediapipe']={'version':MP_VERSION,'npmIntegrity':integrity}
    if selected & {'rvm','modnet','depth'} and not all(x in files for x in ORT_FILES):
        print('[2] ONNX Runtime Web '+ORT_VERSION, flush=True)
        tar, integrity = npm_package(cache,'onnxruntime-web',ORT_VERSION)
        with tar:
            for name in ORT_FILES:
                files[name]=read_member(tar,'dist/'+name.split('/')[-1])
        packages['onnxruntime-web']={'version':ORT_VERSION,'npmIntegrity':integrity}
    for key in MODELS:
        if key not in selected:
            continue
        name,url=MODELS[key]
        relative='models/'+name
        if relative not in files:
            print('[3] Модель '+key+' — '+name, flush=True)
            files[relative]=cached(cache,name,url)
    for name,data in files.items():
        validate_binary(data,name)
        atomic_write(EXT/name,data)
    installed=installed_from_files(files)
    if not all(installed[x] for x in selected):
        raise ValueError('Не все выбранные модели подготовлены')
    lock={'schema':1,'version':'0.4.2','packages':packages,'installed':installed,
          'modelSources':{k:v[1] for k,v in MODELS.items() if installed[k]},
          'modelIntegrityNote':'npm archives use registry SHA-512. Model SHA-256 values are local first-download fingerprints, not independent publisher signatures.',
          'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
    atomic_write(ROOT/'DEPENDENCIES.lock.json',json.dumps(lock,indent=2,ensure_ascii=False).encode())
    build={'version':'0.4.2','prepared':True,'installed':installed}
    atomic_write(EXT/'build-info.js',('globalThis.AuraBuild = Object.freeze('+json.dumps(build,ensure_ascii=False)+');\n').encode())
    validate_complete()
    print('[4] Готово. Проверены локальные файлы: '+', '.join(k for k,v in installed.items() if v), flush=True)
    print('Это проверка файлов, не тест нейросетей. Для проверки моделей откройте предпросмотр расширения.')
    print('Загрузите в Chrome папку:\n'+str(EXT))
    print('Отключите старые Aura Camera, затем обновите страницы звонков. Google Meet по умолчанию исключён.')

def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--all',action='store_true',help='Все пять вариантов: MediaPipe, RVM, MODNet, MiDaS depth')
    parser.add_argument('--models',default='fast,multiclass',help='Список через запятую: fast,multiclass,rvm,modnet,depth')
    parser.add_argument('--check',action='store_true',help='Проверить уже подготовленные файлы без сети')
    parser.add_argument('--cache-dir',type=Path,default=ROOT/'.cache')
    args=parser.parse_args()
    try:
        if args.check:
            lock=validate_complete()
            print('Проверка файлов пройдена: '+', '.join(k for k,v in lock['installed'].items() if v))
        else:
            selected=set(MODELS) if args.all else set(args.models.split(','))
            if not selected or not selected<=set(MODELS):
                raise ValueError('Неизвестный список --models')
            prepare(selected,args.cache_dir)
        return 0
    except (Exception,KeyboardInterrupt) as e:
        print('\nПОДГОТОВКА НЕ ЗАВЕРШЕНА:\n'+str(e),file=sys.stderr)
        print('Не отключайте TLS. После исправления доступа к сети повторите команду. Успешные загрузки находятся в .cache.',file=sys.stderr)
        return 1

if __name__=='__main__':
    raise SystemExit(main())
