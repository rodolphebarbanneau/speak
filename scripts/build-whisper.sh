#!/usr/bin/env bash
# Build whisper-server + parakeet-cli from source into vendor/whisper/<os>, to be bundled in
# release builds (electron-builder extraResources). Used for macOS, where whisper.cpp
# publishes no command-line binaries. Requires git, cmake and a C++ toolchain (Xcode CLT).
set -euo pipefail

TAG="${WHISPER_CPP_TAG:-b5454}" # keep in sync with src/main/stt/catalog.ts
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINS=(whisper-server parakeet-cli)

case "$(uname -s)" in
  Darwin) OUT="$ROOT/vendor/whisper/mac" ;;
  Linux) OUT="$ROOT/vendor/whisper/linux" ;;
  *) echo "Unsupported OS; Windows uses the official prebuilt binaries." >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$WORK/src"

# build <dir> [cmake options...]
build() {
  local dir="$1"
  shift
  cmake -S "$WORK/src" -B "$dir" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON "$@"
  cmake --build "$dir" --config Release -j
}

mkdir -p "$OUT"
if [ "$(uname -s)" = Darwin ]; then
  # Universal binaries, so both Mac builds of Speak bundle the same folder. Apple Silicon runs on
  # Metal; Intel Macs run on the CPU (AVX2 + Accelerate), as ggml's Metal backend is unreliable
  # on their GPUs. 13.3 is the oldest macOS with the Accelerate interface ggml uses.
  MAC=(-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 -DGGML_OPENMP=OFF)
  build "$WORK/arm64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
  build "$WORK/x86_64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_METAL=OFF -DGGML_NATIVE=OFF
  for bin in "${BINS[@]}"; do
    if [ -f "$WORK/arm64/bin/$bin" ]; then lipo -create "$WORK/arm64/bin/$bin" "$WORK/x86_64/bin/$bin" -output "$OUT/$bin"; fi
  done
  lipo -info "$OUT/whisper-server"
else
  build "$WORK/build" -DGGML_VULKAN="${GGML_VULKAN:-OFF}"
  for bin in "${BINS[@]}"; do
    if [ -f "$WORK/build/bin/$bin" ]; then cp "$WORK/build/bin/$bin" "$OUT/"; fi
  done
fi
cp "$WORK/src/LICENSE" "$OUT/LICENSE-whisper.cpp"
echo "Built whisper.cpp $TAG into $OUT:"
ls -la "$OUT"
