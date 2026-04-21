#!/usr/bin/env bash
set -u

PROFILE="${PROFILE:-release}"
STOP_ON_ERROR="${STOP_ON_ERROR:-0}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="$PROJECT_ROOT/target/build"

TARGETS=(
  "x86_64-pc-windows-msvc"
  "x86_64-unknown-linux-gnu"
  "aarch64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
)

platform_name() {
  case "$1" in
    x86_64-pc-windows-msvc) echo "windows-x64" ;;
    aarch64-pc-windows-msvc) echo "windows-arm64" ;;
    x86_64-unknown-linux-gnu) echo "linux-x64" ;;
    aarch64-unknown-linux-gnu) echo "linux-arm64" ;;
    x86_64-apple-darwin) echo "macos-x64" ;;
    aarch64-apple-darwin) echo "macos-arm64" ;;
    *) echo "$1" ;;
  esac
}

binary_name() {
  case "$1" in
    *windows*) echo "ferrum-proxy.exe" ;;
    *) echo "ferrum-proxy" ;;
  esac
}

mkdir -p "$OUT_ROOT"
MANIFEST="$OUT_ROOT/manifest.json"
printf '[\n' > "$MANIFEST"
FIRST=1
FAILED=0

for TARGET in "${TARGETS[@]}"; do
  PLATFORM="$(platform_name "$TARGET")"
  BINARY="$(binary_name "$TARGET")"
  PROFILE_DIR="$PROFILE"
  TARGET_BINARY="$PROJECT_ROOT/target/$TARGET/$PROFILE_DIR/$BINARY"
  PLATFORM_DIR="$OUT_ROOT/$PLATFORM"
  OUT_BINARY="$PLATFORM_DIR/$BINARY"

  echo "==> Building $PLATFORM ($TARGET)"
  if command -v rustup >/dev/null 2>&1; then
    rustup target add "$TARGET"
  fi

  if [[ "$PROFILE" == "release" ]]; then
    BUILD_CMD=(cargo build --target "$TARGET" --release)
  else
    BUILD_CMD=(cargo build --target "$TARGET")
  fi

  OK=true
  ERROR=""
  if ! (cd "$PROJECT_ROOT" && "${BUILD_CMD[@]}"); then
    OK=false
    ERROR="cargo build failed"
    FAILED=1
  fi

  if [[ "$OK" == "true" ]]; then
    mkdir -p "$PLATFORM_DIR"
    cp -f "$TARGET_BINARY" "$OUT_BINARY"
  elif [[ "$STOP_ON_ERROR" == "1" ]]; then
    exit 1
  fi

  if [[ "$FIRST" == "0" ]]; then
    printf ',\n' >> "$MANIFEST"
  fi
  FIRST=0
  if [[ "$OK" == "true" ]]; then
    printf '  {"platform":"%s","target":"%s","ok":true,"binary":"%s","error":null}' "$PLATFORM" "$TARGET" "$OUT_BINARY" >> "$MANIFEST"
  else
    printf '  {"platform":"%s","target":"%s","ok":false,"binary":null,"error":"%s"}' "$PLATFORM" "$TARGET" "$ERROR" >> "$MANIFEST"
  fi
done

printf '\n]\n' >> "$MANIFEST"

echo ""
echo "Build output: $OUT_ROOT"
echo "Manifest: $MANIFEST"

if [[ "$FAILED" == "1" && "$STOP_ON_ERROR" == "1" ]]; then
  exit 1
fi
