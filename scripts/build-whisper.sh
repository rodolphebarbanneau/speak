#!/usr/bin/env bash
# Build whisper-server + parakeet-cli from source into vendor/whisper/<os>, to be bundled in
# release builds (electron-builder extraResources). Used for macOS, where whisper.cpp
# publishes no command-line binaries. Requires git, cmake and a C++ toolchain (Xcode CLT).
set -euo pipefail

TAG="${WHISPER_CPP_TAG:-b5454}" # keep in sync with src/main/stt/catalog.ts
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$(uname -s)" in
  Darwin) OUT="$ROOT/vendor/whisper/mac"; EXTRA=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
  Linux) OUT="$ROOT/vendor/whisper/linux"; EXTRA=(-DGGML_VULKAN="${GGML_VULKAN:-OFF}") ;;
  *) echo "Unsupported OS; Windows uses the official prebuilt binaries." >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON "${EXTRA[@]}"
cmake --build "$WORK/build" --config Release -j

mkdir -p "$OUT"
cp "$WORK/build/bin/whisper-server" "$OUT/"
if [ -f "$WORK/build/bin/parakeet-cli" ]; then cp "$WORK/build/bin/parakeet-cli" "$OUT/"; fi
cp "$WORK/src/LICENSE" "$OUT/LICENSE-whisper.cpp"
echo "Built whisper.cpp $TAG into $OUT:"
ls -la "$OUT"
