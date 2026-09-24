"""Offline updater tests; dummy dependency bytes are not ML execution tests."""
import importlib.util,json,hashlib,tempfile,shutil,unittest
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('updater',ROOT/'update.py');U=importlib.util.module_from_spec(spec);spec.loader.exec_module(U)
class UpdateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.target=Path(self.tmp.name)/'installed';ext=self.target/'extension';ext.mkdir(parents=True)
  self.oldManifest=json.dumps({'manifest_version':3,'name':'Aura Camera — виртуальный фон','version':'0.4.0'})
  (ext/'manifest.json').write_text(self.oldManifest)
  (ext/'core.js').write_text('// old code')
  (self.target/'prepare.py').write_text('# previous preparer')
  self.dependencies={}
  for name in ['vendor/vision.bundle.js','vendor/wasm-loader.js','vendor/vision_wasm_internal.wasm','models/selfie_segmenter_landscape.tflite']:
   p=ext/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'dummy dependency bytes, not a real model: '+name.encode());self.dependencies[name]=hashlib.sha256(p.read_bytes()).hexdigest()
  installed={'fast':True,'multiclass':False,'rvm':False,'modnet':False,'depth':False}
  (self.target/'DEPENDENCIES.lock.json').write_text(json.dumps({'files':self.dependencies,'installed':installed,'packages':{'mediapipe':{'version':'0.10.21'}},'version':'0.4.0'}))
  (ext/'build-info.js').write_text('old build')
  (self.target/'.cache').mkdir();(self.target/'.cache/keep').write_text('cached')
 def tearDown(self):self.tmp.cleanup()
 def test_success_models_cache_preserved(self):
  backup=U.update(self.target)
  self.assertTrue((backup/'backup.json').exists());self.assertEqual(json.loads((self.target/'extension/manifest.json').read_text())['version'],'0.4.2')
  for rel,h in self.dependencies.items():self.assertEqual(hashlib.sha256((self.target/'extension'/rel).read_bytes()).hexdigest(),h)
  self.assertEqual((self.target/'.cache/keep').read_text(),'cached');self.assertTrue((self.target/'extension/native/refiner-simd.wasm').is_file())
 def test_upgrade_from_041(self):
  p=self.target/'extension/manifest.json';m=json.loads(p.read_text());m['version']='0.4.1';p.write_text(json.dumps(m))
  backup=U.update(self.target);self.assertTrue(backup.name.startswith('0.4.1-'))
  self.assertEqual(json.loads(p.read_text())['version'],'0.4.2')
  U.restore(self.target,backup);self.assertEqual(json.loads(p.read_text())['version'],'0.4.1')
 def test_installed_model_list_preserved(self):
  U.update(self.target);lock=json.loads((self.target/'DEPENDENCIES.lock.json').read_text());self.assertTrue(lock['installed']['fast']);self.assertFalse(lock['installed']['rvm']);self.assertEqual(lock['packages']['mediapipe']['version'],'0.10.21')
  self.assertIn('"rvm": false',(self.target/'extension/build-info.js').read_text())
 def test_extension_directory_accepted(self):self.assertTrue(U.update(self.target/'extension').is_dir())
 def test_rollback_restores_old_and_removes_new_files(self):
  backup=U.update(self.target);U.restore(self.target,backup)
  self.assertEqual((self.target/'extension/manifest.json').read_text(),self.oldManifest);self.assertEqual((self.target/'extension/core.js').read_text(),'// old code');self.assertFalse((self.target/'extension/native/refiner-simd.wasm').exists())
 def test_wrong_version_no_changes(self):
  p=self.target/'extension/manifest.json';m=json.loads(p.read_text());m['version']='0.3.1';p.write_text(json.dumps(m))
  with self.assertRaises(ValueError):U.update(self.target)
  self.assertFalse((self.target/'.backups').exists())
 def test_corrupt_dependency_blocks_before_write(self):
  (self.target/'extension/models/selfie_segmenter_landscape.tflite').write_bytes(b'corrupt')
  with self.assertRaises(ValueError):U.update(self.target)
  self.assertEqual((self.target/'extension/core.js').read_text(),'// old code')
 def test_path_traversal_blocked(self):
  with self.assertRaises(ValueError):U.checked_path(self.target,'../../outside')
 def test_failed_write_rolls_back(self):
  real=U.atomic_write;count=0
  def failing(path,data):
   nonlocal count
   count+=1
   if count==4:raise OSError('test write failure')
   return real(path,data)
  with mock.patch.object(U,'atomic_write',side_effect=failing):
   with self.assertRaises(OSError):U.update(self.target)
  self.assertEqual((self.target/'extension/core.js').read_text(),'// old code');self.assertEqual((self.target/'extension/manifest.json').read_text(),self.oldManifest)
if __name__=='__main__':unittest.main(verbosity=2)
