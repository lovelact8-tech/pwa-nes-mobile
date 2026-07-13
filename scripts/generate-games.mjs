import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const publicDir = path.resolve('public');
const libraryDir = path.join(publicDir, 'FC中文游戏');
const outputFile = path.join(publicDir, 'games.json');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) files.push(fullPath);
  }
  return files;
}

const files = await walk(libraryDir);
const games = files.map((file) => {
  const relative = path.relative(publicDir, file).split(path.sep);
  const fileName = relative.at(-1).replace(/\.zip$/i, '');
  return {
    name: fileName,
    path: relative.map(encodeURIComponent).join('/'),
  };
}).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

await writeFile(outputFile, `${JSON.stringify(games)}\n`);
console.log(`已生成 ${games.length} 个游戏的目录：${outputFile}`);
