#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPOSITORY_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
DOCKERFILE="${SCRIPT_DIR}/linux-arm64-builder.Dockerfile"
BUILDER_IMAGE="${FAN_LINUX_BUILDER_IMAGE:-fan-desktop-linux-arm64-builder:node22}"
VERSION="$(node -p "require('${DESKTOP_DIR}/package.json').version")"
COMMIT="$(git -C "${REPOSITORY_ROOT}" rev-parse HEAD)"

command -v docker >/dev/null || { echo "✖ Linux 打包需要 Docker" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "✖ Docker 尚未启动" >&2; exit 2; }

if [[ -n "$(git -C "${REPOSITORY_ROOT}" status --porcelain --untracked-files=no)" ]]; then
  echo "✖ 仓库有未提交修改。请先提交，再从确定的 commit 打包。" >&2
  exit 2
fi

BUILD_DIR="$(mktemp -d "/tmp/fan-linux-${VERSION}.XXXXXX")"
SOURCE_DIR="${BUILD_DIR}/fan-agent"
cleanup() {
  [[ -n "${BUILD_DIR:-}" && -d "${BUILD_DIR}" ]] && rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

echo "→ 准备可缓存的 Linux ARM64 构建镜像"
docker build \
  --platform linux/arm64 \
  --file "${DOCKERFILE}" \
  --tag "${BUILDER_IMAGE}" \
  "${SCRIPT_DIR}"

echo "→ 从 commit ${COMMIT:0:12} 导出干净源码"
mkdir -p "${SOURCE_DIR}"
git -C "${REPOSITORY_ROOT}" archive HEAD | tar -xf - -C "${SOURCE_DIR}"

echo "→ 在 Docker 中打包 Linux ARM64 v${VERSION}"
docker run --rm \
  --platform linux/arm64 \
  --env "GITHUB_SHA=${COMMIT}" \
  --volume "${SOURCE_DIR}:/work" \
  --volume fan-desktop-npm-cache:/root/.npm \
  --volume fan-desktop-uv-cache:/root/.cache/uv \
  --volume fan-desktop-uv-python:/root/.local/share/uv/python \
  --volume fan-desktop-electron-cache:/root/.cache/electron \
  --volume fan-desktop-builder-cache:/root/.cache/electron-builder \
  --workdir /work \
  "${BUILDER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    npm ci
    node apps/desktop/scripts/prepare-linux-arm64-native-deps.mjs
    npm --prefix apps/desktop run dist:linux
  '

SOURCE_RELEASE="${SOURCE_DIR}/apps/desktop/release"
declare -a ARTIFACTS=(
  "Fan-${VERSION}-linux-arm64.AppImage"
  "Fan-${VERSION}-linux-arm64.deb"
  "Fan-${VERSION}-linux-aarch64.rpm"
)

for artifact in "${ARTIFACTS[@]}"; do
  [[ -f "${SOURCE_RELEASE}/${artifact}" ]] || { echo "✖ 缺少 ${artifact}" >&2; exit 2; }
  cp "${SOURCE_RELEASE}/${artifact}" "${DESKTOP_DIR}/release/${artifact}"
done

echo "✔ Linux ARM64 v${VERSION} 已输出到 ${DESKTOP_DIR}/release"
shasum -a 256 "${ARTIFACTS[@]/#/${DESKTOP_DIR}\/release\/}"
