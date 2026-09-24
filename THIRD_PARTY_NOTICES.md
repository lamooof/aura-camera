# Third-party components and provenance

Aura Camera 0.4.2 is an independent experimental project, not affiliated with or endorsed by Google, Yandex, Chrome, Ubuntu, MediaPipe, RVM, MODNet or MiDaS.

The distributed source ZIP contains original Aura code, backgrounds, icons, documentation and test fixtures. It does not contain neural-network weights or vendor JS/WASM. `prepare.py` fetches optional third-party components. Original Aura code remains under the root MIT license; this does not relicense third-party components.

| Component | Pinned source | Upstream terms / attribution |
|---|---|---|
| MediaPipe Tasks Vision | npm `@mediapipe/tasks-vision` 0.10.21 | Apache-2.0; Google / MediaPipe authors. Only the export/factory wrapper is adapted for static isolated-world scripts. |
| Selfie Landscape / SelfieMulticlass | Google Storage image_segmenter, model version1 | Google MediaPipe model sources/cards linked by official documentation. Preserve their model terms and cards. |
| ONNX Runtime Web | npm `onnxruntime-web` 1.22.0 | MIT; Microsoft and contributors. Vendor files unmodified. |
| Robust Video Matting | PeterL1n/RobustVideoMatting release v1.0.0, MobileNetV3 FP32 ONNX | GPL-3.0; RVM authors. RVM is an optional downloadable component, not covered by Aura's MIT license. |
| MODNet Webcam ONNX | yakhyo/modnet release tag `weights`, `modnet_webcam.onnx` | Community export of MODNet. MODNet upstream code/models are offered under Apache-2.0; yakhyo repository uses Apache-2.0. Preserve upstream attribution. |
| MiDaS Small256 | isl-org/MiDaS v2_1, `model-small.onnx` | MIT; Intel ISL / MiDaS contributors. |

License references:

- https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
- https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter
- https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE
- https://github.com/microsoft/onnxruntime/blob/v1.22.0/ThirdPartyNotices.txt
- https://github.com/PeterL1n/RobustVideoMatting/blob/master/LICENSE
- https://github.com/ZHKKKe/MODNet/blob/master/LICENSE
- https://github.com/yakhyo/modnet/blob/main/LICENSE
- https://github.com/isl-org/MiDaS/blob/master/LICENSE

The generic Apache-2.0 and GPL-3.0 texts are included under `licenses/`. They are not substitutes for each component's copyright notices or complete upstream source. Source repositories are linked above. Before distributing a prepared package containing RVM or other downloaded components, preserve the applicable notices and satisfy their source/distribution terms; do not label the entire prepared package “MIT only”.

`prepare.py` verifies npm archive SHA-512 against registry metadata and records local SHA-256 hashes of resulting files. Model file SHA-256 values are first-download fingerprints, **not independently verified publisher signatures**. Format/header validation does not establish model correctness. Release tags and model-version URLs are fixed in the script, but their remote bytes can still be replaced upstream.

The RGB guided filter is an original JavaScript implementation based on the method described by Kaiming He, Jian Sun and Xiaoou Tang, Guided Image Filtering. No author's source implementation is copied. Method reference: https://people.csail.mit.edu/kaiming/eccv10/index.html

The small native/refiner*.wasm files bundled in 0.4.2 are compiled from the original Aura native/refiner.c under the root MIT license. They are not MediaPipe/ONNX runtimes or model weights. Compiler version, source and output hashes are in native/BUILD.json.
