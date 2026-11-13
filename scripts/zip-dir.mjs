// 无依赖的目录打包：把目录内容（不含目录本身）写成 zip，路径统一使用 "/"。
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const full = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    });
}

export function zipDirectory(sourceDir, targetFile) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const files = listFiles(sourceDir);
  for (const file of files) {
    const name = Buffer.from(relative(sourceDir, file).split(sep).join('/'), 'utf8');
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const stored = compressed.length >= data.length;
    const body = stored ? data : compressed;
    const method = stored ? 0 : 8;
    const mtime = statSync(file).mtime;
    const dosTime = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1);
    const dosDate = ((Math.max(mtime.getFullYear(), 1980) - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // Unix 创建
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, Buffer.concat([...localParts, ...centralParts, end]));
  return files.length;
}
