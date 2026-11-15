// A minimal streaming ZIP writer: deflated files, UTF-8 names, no ZIP64
// (exports stay far below 4 GB). Only one file is in memory at a time, so a
// space of any size exports without holding it all. Small enough not to
// need a package.
import { crc32, deflateRawSync } from "node:zlib";

type Entry = { name: string; data: Buffer };

export async function* zipStream(
  files: AsyncIterable<Entry> | Iterable<Entry>,
): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const packed = deflateRawSync(f.data);
    const head = (size: number) => {
      const b = Buffer.alloc(size);
      b.writeUInt16LE(20, size === 30 ? 4 : 6); // version needed
      b.writeUInt16LE(0x0800, size === 30 ? 6 : 8); // UTF-8 names
      b.writeUInt16LE(8, size === 30 ? 8 : 10); // deflate
      const at = size === 30 ? 14 : 16;
      b.writeUInt32LE(crc32(f.data), at);
      b.writeUInt32LE(packed.length, at + 4);
      b.writeUInt32LE(f.data.length, at + 8);
      b.writeUInt16LE(name.length, at + 12);
      return b;
    };
    const local = head(30);
    local.writeUInt32LE(0x04034b50, 0);
    const entry = head(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt32LE(offset, 42);
    yield Buffer.concat([local, name, packed]);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
    count++;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([dir, end]);
}
