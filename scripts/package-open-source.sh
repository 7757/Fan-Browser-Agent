#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_PATH="${1:-${SOURCE_ROOT}/fan-open-source.tar.gz}"

case "${OUTPUT_PATH}" in
  /*) ;;
  *) OUTPUT_PATH="${PWD}/${OUTPUT_PATH}" ;;
esac

OUTPUT_PARENT="$(dirname "${OUTPUT_PATH}")"
mkdir -p "${OUTPUT_PARENT}"

if [[ -e "${OUTPUT_PATH}" ]]; then
  echo "Refusing to overwrite existing archive: ${OUTPUT_PATH}" >&2
  exit 2
fi

# Ask Git to apply every nested .gitignore without modifying the source tree.
# A temporary empty index makes every publishable file appear as an untracked
# candidate; ignored dependencies, build products, secrets, and local state are
# omitted before tar sees the list. The archive itself lives outside that walk.
INDEX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fan-open-source-index.XXXXXX")"
FILE_LIST="${INDEX_DIR}/files"
cleanup() {
  [[ -n "${INDEX_DIR:-}" && -d "${INDEX_DIR}" ]] && rm -rf "${INDEX_DIR}"
}
trap cleanup EXIT

git -C "${INDEX_DIR}" init --quiet
(
  cd "${SOURCE_ROOT}"
  git \
    --git-dir="${INDEX_DIR}/.git" \
    --work-tree="${SOURCE_ROOT}" \
    ls-files --others --exclude-standard -z > "${FILE_LIST}"
)
COPYFILE_DISABLE=1 tar \
  -C "${SOURCE_ROOT}" \
  --no-mac-metadata \
  --no-xattrs \
  --numeric-owner \
  --uid 0 \
  --gid 0 \
  --null \
  -T "${FILE_LIST}" \
  -czf "${OUTPUT_PATH}"

echo "Created ${OUTPUT_PATH}"
du -h "${OUTPUT_PATH}"
