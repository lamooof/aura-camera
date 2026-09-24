const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MediaDevices {
  getUserMedia() { return Promise.resolve('native stream'); }
}
class MediaStreamTrack {
  stop() {}
  clone() { return new MediaStreamTrack(); }
}
class MediaStream {
  clone() { return new MediaStream(); }
}

const navigator = {
  mediaDevices: new MediaDevices(),
  getUserMedia() {},
  webkitGetUserMedia() {},
};
const nativeGetUserMedia = MediaDevices.prototype.getUserMedia;
const window = { addEventListener() {}, postMessage() {} };
const context = vm.createContext({
  navigator, MediaStreamTrack, MediaStream, window, Symbol, Object,
  WeakMap, Set, Promise,
});
const source = fs.readFileSync(path.join(__dirname, '../extension/main.js'), 'utf8');
vm.runInContext(source, context);

for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, name);
  assert.equal(descriptor.writable, true, `${name} must remain writable for meeting SDKs`);
  const replacement = () => 'SDK replacement';
  vm.runInContext(`navigator.${name} = replacement`, vm.createContext({ navigator, replacement }));
  assert.equal(navigator[name], replacement);
}
assert.notEqual(navigator.mediaDevices.getUserMedia, nativeGetUserMedia);
console.log('PASS legacy getUserMedia aliases remain writable');
