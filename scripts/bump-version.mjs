#!/usr/bin/env node
// 统一版本号:一处命令改齐产品的三个版本真源。
//
//   node scripts/bump-version.mjs 0.1.0
//
// 桌面前端(apps/desktop/package.json)、后端(fan_cli/__init__.py)、
// 打包清单(pyproject.toml 的 [project] version)必须一致——electron-builder
// 读前者命名产物与 latest*.yml,About 面读后端 __version__,发布链据此对齐。
// 发版前跑这个,再 build + publish。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('用法: node scripts/bump-version.mjs <x.y.z>\n例:  node scripts/bump-version.mjs 0.1.0');
  process.exit(1);
}

/** 就地替换单文件里第一个匹配;未命中即报错(防止版本悄悄漏改)。 */
function patch(rel, regex, replacement) {
  const file = path.join(REPO, rel);
  const src = fs.readFileSync(file, 'utf8');
  if (!regex.test(src)) {
    console.error(`✖ ${rel}: 未找到版本字段(${regex})`);
    process.exit(1);
  }
  fs.writeFileSync(file, src.replace(regex, replacement), 'utf8');
  console.log(`✔ ${rel} → ${version}`);
}

// apps/desktop/package.json: "version": "x.y.z"
patch('apps/desktop/package.json', /"version":\s*"[^"]+"/, `"version": "${version}"`);
// fan_cli/__init__.py: __version__ = "x.y.z"
patch('fan_cli/__init__.py', /__version__\s*=\s*"[^"]+"/, `__version__ = "${version}"`);
// pyproject.toml: 行首 version = "x.y.z"([project] 段;不误伤 deps 行)
patch('pyproject.toml', /^version\s*=\s*"[^"]+"/m, `version = "${version}"`);

console.log(`\n版本已统一为 ${version}。下一步:`);
console.log('  node apps/desktop/scripts/build-python-backend.mjs   # 让 fan-src 带上新版本');
console.log('  cd apps/desktop && npm run dist:mac                  # 或 dist:win');
