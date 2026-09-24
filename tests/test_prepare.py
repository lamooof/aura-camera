"""Offline installer tests: generated fixtures are NOT actual models or runtimes."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare', ROOT/'prepare.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def archive(files):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as tar:
        for name,data in files.items():
            info=tarfile.TarInfo('package/'+name);info.size=len(data)
            tar.addfile(info,io.BytesIO(data))
    return stream.getvalue()

WASM=b'\0asm\1\0\0\0'+bytes(1000000)
TFLITE=bytes(4)+b'TFL3'+bytes(100000)
ONNX=b'\x08\x07'+bytes(100000)
MP=archive({'vision_bundle.mjs':b'const Segmenter={}; export {Segmenter as ImageSegmenter};',
            'wasm/vision_wasm_internal.js':b'var ModuleFactory=()=>Promise.resolve({});',
            'wasm/vision_wasm_internal.wasm':WASM})
ORT=archive({'dist/ort.all.min.js':b'globalThis.ort={};',
             'dist/ort-wasm-simd-threaded.jsep.mjs':b'export default function(){};',
             'dist/ort-wasm-simd-threaded.jsep.wasm':WASM})


def fake_download(url,maximum=P.MAX_DOWNLOAD):
    if url.endswith('.tflite'):return TFLITE
    if url.endswith('.onnx'):return ONNX
    is_mp='tasks-vision' in url
    data=MP if is_mp else ORT
    if url.endswith('.tgz'):return data
    return json.dumps({'name':'@mediapipe/tasks-vision' if is_mp else 'onnxruntime-web',
                       'version':P.MP_VERSION if is_mp else P.ORT_VERSION,
                       'dist':{'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}}).encode()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        shutil.copytree(ROOT/'extension',self.root/'extension')
        self.context=contextlib.ExitStack();self.context.enter_context(patch.object(P,'ROOT',self.root))
        self.context.enter_context(patch.object(P,'EXT',self.root/'extension'))
        self.mock=self.context.enter_context(patch.object(P,'download',side_effect=fake_download))
        self.context.enter_context(contextlib.redirect_stdout(io.StringIO()))
    def tearDown(self):
        self.context.close();self.tmp.cleanup()
    def prepare(self,selected):
        P.prepare(set(selected),self.root/'.cache');return P.validate_complete()
    def test_manifest_already_present(self):
        m=json.loads((P.EXT/'manifest.json').read_text());self.assertEqual(m['version'],'0.4.2')
        self.assertTrue((P.EXT/'build-info.js').is_file())
    def test_default_only_media_pipe(self):
        lock=self.prepare(['fast','multiclass'])
        self.assertEqual(lock['installed'],dict(fast=True,multiclass=True,rvm=False,modnet=False,depth=False))
        self.assertFalse((P.EXT/'vendor/ort.all.min.js').exists())
    def test_all_models_prepared_and_checked(self):
        lock=self.prepare(P.MODELS)
        self.assertTrue(all(lock['installed'].values()));self.assertEqual(len(lock['files']),11)
    def test_depth_pulls_multiclass_and_both_runtimes(self):
        lock=self.prepare(['depth'])
        self.assertTrue(lock['installed']['depth']);self.assertTrue(lock['installed']['multiclass'])
        self.assertFalse(lock['installed']['fast']);self.assertFalse(lock['installed']['rvm'])
    def test_rvm_only_needs_ort(self):
        lock=self.prepare(['rvm']);self.assertTrue(lock['installed']['rvm'])
        self.assertNotIn('mediapipe',lock['packages'])
    def test_repeated_prepare_does_not_redownload(self):
        self.prepare(P.MODELS);self.mock.reset_mock();self.prepare(P.MODELS)
        self.mock.assert_not_called()
    def test_incremental_install_preserves_models(self):
        self.prepare(['fast']);lock=self.prepare(['rvm'])
        self.assertTrue(lock['installed']['fast']);self.assertTrue(lock['installed']['rvm'])
    def test_modified_model_fails_offline_check(self):
        self.prepare(['fast']);(P.EXT/'models/selfie_segmenter_landscape.tflite').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'изменён'):P.validate_complete()
    def test_mismatched_build_fails_check(self):
        self.prepare(['fast']);(P.EXT/'build-info.js').write_text('globalThis.AuraBuild={};')
        with self.assertRaisesRegex(ValueError,'build-info'):P.validate_complete()
    def test_missing_manifest_script_fails_check(self):
        self.prepare(['fast']);(P.EXT/'engine.js').unlink()
        with self.assertRaisesRegex(ValueError,'Нет файла'):P.validate_complete()
    def test_lock_path_traversal_rejected(self):
        self.prepare(['fast']);p=self.root/'DEPENDENCIES.lock.json';lock=json.loads(p.read_text())
        lock['files']['../escape.txt']='hash';p.write_text(json.dumps(lock))
        with self.assertRaisesRegex(ValueError,'Недопустимый путь'):P.validate_complete()
    def test_http_untrusted_host_and_userinfo_rejected(self):
        for url in ['http://github.com/x','https://github.com.evil/x','https://u:p@github.com/x','file:///tmp/model']:
            with self.subTest(url=url),self.assertRaises(ValueError):P.validate_url(url)
        P.validate_url(P.MODELS['rvm'][1])
    def test_redirect_to_unapproved_host_rejected(self):
        with self.assertRaises(ValueError):P.SafeRedirect().redirect_request(None,None,302,'',{},'https://evil.invalid/x')
    def test_npm_integrity_mismatch_rejected(self):
        c=self.root/'.cache';c.mkdir();(c/f'tasks-vision-{P.MP_VERSION}.tgz').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'сумма'):P.npm_package(c,'@mediapipe/tasks-vision',P.MP_VERSION)
    def test_wrong_package_metadata_rejected(self):
        c=self.root/'.cache';c.mkdir();(c/f'tasks-vision-{P.MP_VERSION}.json').write_text('{"name":"other","version":"0"}')
        with self.assertRaisesRegex(ValueError,'метаданные'):P.npm_package(c,'@mediapipe/tasks-vision',P.MP_VERSION)
    def test_tflite_wasm_onnx_html_rejected(self):
        for name in ['model.tflite','model.onnx','runtime.wasm']:
            with self.subTest(name=name),self.assertRaises(ValueError):P.validate_binary(b'<html>'+bytes(1100000),name)
    def test_tar_symlink_is_never_extracted(self):
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w:gz') as t:
            i=tarfile.TarInfo('package/f.js');i.type=tarfile.SYMTYPE;i.linkname='/etc/passwd';t.addfile(i)
        with tarfile.open(fileobj=io.BytesIO(data.getvalue()),mode='r:gz') as t:
            with self.assertRaisesRegex(ValueError,'Недопустимый'):P.read_member(t,'f.js')
    def test_classic_media_pipe_wrapper(self):
        s=P.adapt_bundle('const a=1;export{a as ImageSegmenter};')
        self.assertIn('globalThis.AuraVision',s);self.assertNotIn('export{',s)
    def test_unknown_bundle_and_import_rejected(self):
        for s in ['export default {}','import {x} from "remote";export{x as ImageSegmenter};','const x=1;export{x};']:
            with self.subTest(s=s),self.assertRaises(ValueError):P.adapt_bundle(s)
    def test_unknown_emscripten_wrapper_rejected(self):
        with self.assertRaises(ValueError):P.adapt_loader('export default function(){}')
    def test_download_failure_does_not_publish_prepared_build(self):
        with patch.object(P,'download',side_effect=RuntimeError('Network unavailable')):
            with self.assertRaises(RuntimeError):self.prepare(['fast'])
        self.assertFalse((self.root/'DEPENDENCIES.lock.json').exists())
        self.assertIn('false',(P.EXT/'build-info.js').read_text())
    def test_cached_oversized_content_rejected(self):
        c=self.root/'.cache';c.mkdir();(c/'test').write_bytes(b'123456')
        with self.assertRaisesRegex(ValueError,'кэш'):P.cached(c,'test','https://github.com/test',5)

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(InstallerTests))
    report={'realDownloads':False,'realModels':False,'testsRun':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}
    (ROOT/'tests/installer-report.json').write_text(json.dumps(report,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
