// Read-only ext4 walker: the radio.img sparse payload is an EXT4 filesystem
// (verified: dumpe2fs on the unsparsed image; features extent, 64bit, flex_bg,
// metadata_csum, 128-byte inodes), so the container layer needs the same tree
// walk Fat16Image provides for the Samsung partitions. This test pins the
// walker against a hand-built minimal ext4 (1024-byte blocks, one group,
// extents incl. a non-contiguous two-extent file, linear directory entries).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserFileSource } from "../js/lib/source.js";
import { Ext4Image } from "../js/lib/ext4.js";

const BS = 1024;

// --- synthetic ext4 builder -----------------------------------------------------

function superblock({ blocks, inodesPerGroup, inodeSize, descSize }) {
  const sb = new Uint8Array(BS);
  const dv = new DataView(sb.buffer);
  dv.setUint32(0x00, inodesPerGroup, true); // inodes_count
  dv.setUint32(0x04, blocks, true); // blocks_count_lo
  dv.setUint32(0x08, 0, true); // rsv_blocks
  dv.setUint32(0x0c, 0, true); // free_blocks
  dv.setUint32(0x10, 0, true); // free_inodes
  dv.setUint32(0x14, 1, true); // first_data_block (1 for 1KB blocks)
  dv.setUint32(0x18, 0, true); // log_block_size -> 1024
  dv.setUint32(0x1c, 0, true); // log_cluster_size
  dv.setUint32(0x20, 8192, true); // blocks_per_group
  dv.setUint32(0x24, 8192, true);
  dv.setUint32(0x28, inodesPerGroup, true);
  dv.setUint16(0x38, 0xef53, true); // magic
  dv.setUint32(0x4c, 1, true); // rev_level
  dv.setUint32(0x54, 11, true); // first_ino
  dv.setUint16(0x58, inodeSize, true);
  dv.setUint32(0x5c, 0, true); // feature_compat
  dv.setUint32(0x60, 0x02 | 0x40 | 0x80, true); // incompat: filetype | extents | 64bit
  dv.setUint32(0x64, 0x01, true); // ro_compat: sparse_super
  dv.setUint16(0xfe, descSize, true);
  return sb;
}

function groupDesc({ blockBitmap, inodeBitmap, inodeTable }) {
  const d = new Uint8Array(64);
  const dv = new DataView(d.buffer);
  dv.setUint32(0x00, blockBitmap, true);
  dv.setUint32(0x04, inodeBitmap, true);
  dv.setUint32(0x08, inodeTable, true);
  dv.setUint16(0x10, 2, true); // used_dirs_count
  return d;
}

function extentNode(entries, depth) {
  const node = new Uint8Array(60); // i_block area
  const dv = new DataView(node.buffer);
  dv.setUint16(0, 0xf30a, true); // magic
  dv.setUint16(2, entries.length, true);
  dv.setUint16(4, 4, true); // max
  dv.setUint16(6, depth, true);
  entries.forEach((e, i) => {
    const off = 12 + i * 12;
    if (depth === 0) {
      dv.setUint32(off, e.fileBlock, true);
      dv.setUint16(off + 4, e.len, true);
      dv.setUint16(off + 6, 0, true); // ee_start_hi
      dv.setUint32(off + 8, e.diskBlock, true);
    } else {
      dv.setUint32(off, e.fileBlock, true);
      dv.setUint32(off + 4, e.leaf, true);
      dv.setUint16(off + 8, 0, true);
      dv.setUint16(off + 10, 0, true);
    }
  });
  return node;
}

function inode({ mode, size, flags = 0x80000, extents = [] }) {
  const i = new Uint8Array(128);
  const dv = new DataView(i.buffer);
  dv.setUint16(0x00, mode, true);
  dv.setUint32(0x04, size, true);
  dv.setUint16(0x16, 1, true); // links_count
  dv.setUint32(0x1c, 0, true); // i_blocks_lo (512-byte units, unused here)
  dv.setUint32(0x20, flags, true);
  if (flags & 0x80000) i.set(extentNode(extents, 0), 40);
  return i;
}

function dirent({ inode, name, type, recLen }) {
  // ext4 dirents are 4-byte aligned: 8-byte header + name padded to 4.
  const size = recLen ?? 8 + Math.ceil(name.length / 4) * 4;
  const entry = new Uint8Array(size);
  const dv = new DataView(entry.buffer);
  dv.setUint32(0, inode, true);
  dv.setUint16(4, size, true);
  entry[6] = name.length;
  entry[7] = type; // 1 = regular, 2 = dir
  for (let i = 0; i < name.length; i++) entry[8 + i] = name.charCodeAt(i);
  return entry;
}

function dirBlock(entries) {
  const block = new Uint8Array(BS);
  let off = 0;
  for (const e of entries) {
    block.set(e, off);
    off += e.length;
  }
  // stretch the last entry to the end of the block
  const lastLen = entries[entries.length - 1].length;
  new DataView(block.buffer).setUint16(off - lastLen + 4, BS - (off - lastLen), true);
  return block;
}

function fileData(len, seed) {
  const d = new Uint8Array(len);
  for (let i = 0; i < len; i++) d[i] = (i * seed + 5) & 0xff;
  return d;
}

export function buildExt4Fixture() {
  const blocks = 16;
  const image = new Uint8Array(blocks * BS);
  const put = (block, bytes) => image.set(bytes.subarray(0, Math.min(bytes.length, BS)), block * BS);
  put(1, superblock({ blocks, inodesPerGroup: 16, inodeSize: 128, descSize: 64 }));
  put(2, groupDesc({ blockBitmap: 3, inodeBitmap: 4, inodeTable: 5 }));
  // inodes 5..6 in blocks 5-6 (16 inodes * 128B = 2048B)
  const table = new Uint8Array(2 * BS);
  // inode 1 (pad), 2 root, 3 dir, 4 a.bin, 5 c.bin, 6 b.txt
  const setInode = (n, bytes) => table.set(bytes, (n - 1) * 128);
  setInode(2, inode({ mode: 0x41ed, size: BS, extents: [{ fileBlock: 0, diskBlock: 7, len: 1 }] })); // root
  setInode(3, inode({ mode: 0x41ed, size: BS, extents: [{ fileBlock: 0, diskBlock: 8, len: 1 }] })); // dir
  setInode(4, inode({ mode: 0x81a4, size: 2000, extents: [{ fileBlock: 0, diskBlock: 9, len: 2 }] })); // a.bin
  // c.bin: two NON-contiguous extents (block 9 is a.bin's second half)
  setInode(5, inode({ mode: 0x81a4, size: 2 * BS, extents: [{ fileBlock: 0, diskBlock: 10, len: 1 }, { fileBlock: 1, diskBlock: 12, len: 1 }] }));
  setInode(6, inode({ mode: 0x81a4, size: 10, extents: [{ fileBlock: 0, diskBlock: 13, len: 1 }] }));
  put(5, table);
  const aData = fileData(2000, 11);
  put(9, aData.subarray(0, BS));
  put(10, aData.subarray(BS));
  put(12, fileData(BS, 23)); // c.bin second extent
  put(13, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  put(7, dirBlock([
    dirent({ inode: 2, name: "." }),
    dirent({ inode: 2, name: ".." }),
    dirent({ inode: 3, name: "dir", type: 2 }),
    dirent({ inode: 4, name: "a.bin", type: 1 }),
    dirent({ inode: 5, name: "c.bin", type: 1 }),
  ]));
  put(8, dirBlock([
    dirent({ inode: 3, name: "." }),
    dirent({ inode: 2, name: ".." }),
    dirent({ inode: 6, name: "b.txt", type: 1 }),
  ]));
  return image;
}

const openFixture = () => new Ext4Image(new BrowserFileSource(new Blob([buildExt4Fixture()])));

// Generic one-group ext4 builder for container-chain tests: files is a map of
// absolute path -> bytes; nested paths create directories (insertion order).
export function buildExt4Tree(files) {
  const paths = Object.keys(files);
  const dirs = ["/"];
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = "/" + parts.slice(0, i).join("/");
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  const BS = 1024;
  const dirInode = new Map(dirs.map((d, i) => [d, 3 + i])); // root stays inode 2
  // (dirInode values must match the dirents linked below)
  const dirContents = new Map(dirs.map((d) => [d, [dirent({ inode: 2, name: "." }), dirent({ inode: 2, name: ".." })]]));
  for (const d of dirs.slice(1)) {
    // link each subdirectory into its parent's dirent list
    const parent = d.slice(0, d.lastIndexOf("/")) || "/";
    dirContents.get(parent).push(dirent({ inode: dirInode.get(d), name: d.split("/").pop(), type: 2 }));
  }
  const totalInodes = 2 + dirs.length + paths.length;
  const tableBlocks = Math.ceil((totalInodes * 128) / BS);
  // block plan: 0 boot, 1 super, 2 gdt, 3 bbm, 4 ibm, then inode table, dirs, file data
  let cursor = 5 + tableBlocks;
  const dirBlockNo = new Map();
  for (const d of dirs) dirBlockNo.set(d, cursor++);
  let nextInode = 3 + dirs.length;
  const fileInode = new Map();
  for (const p of paths) {
    const blocks = Math.max(1, Math.ceil(files[p].length / BS));
    fileInode.set(p, { ino: nextInode++, diskBlock: cursor, blocks });
    cursor += blocks;
  }
  const image = new Uint8Array(cursor * BS);
  const put = (block, bytes) => image.set(bytes.subarray(0, Math.min(bytes.length, BS)), block * BS);
  put(1, superblock({ blocks: cursor, inodesPerGroup: totalInodes + 8, inodeSize: 128, descSize: 64 }));
  put(2, groupDesc({ blockBitmap: 3, inodeBitmap: 4, inodeTable: 5 }));
  const table = new Uint8Array(tableBlocks * BS);
  const setInode = (n, bytes) => table.set(bytes, (n - 1) * 128);
  for (const p of paths) {
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    const name = p.split("/").pop();
    const { ino, diskBlock, blocks } = fileInode.get(p);
    setInode(ino, inode({ mode: 0x81a4, size: files[p].length, extents: [{ fileBlock: 0, diskBlock, len: blocks }] }));
    dirContents.get(parent).push(dirent({ inode: ino, name, type: 1 }));
    image.set(files[p], diskBlock * BS);
  }
  for (const d of dirs.slice(1)) {
    const entries = dirContents.get(d);
    entries[1] = dirent({ inode: dirInode.get("/"), name: ".." }); // subdirs hang off root here
    put(dirBlockNo.get(d), dirBlock(entries));
    setInode(dirInode.get(d), inode({ mode: 0x41ed, size: BS, extents: [{ fileBlock: 0, diskBlock: dirBlockNo.get(d), len: 1 }] }));
  }
  setInode(2, inode({ mode: 0x41ed, size: BS, extents: [{ fileBlock: 0, diskBlock: dirBlockNo.get("/"), len: 1 }] }));
  put(5, table);
  put(dirBlockNo.get("/"), dirBlock(dirContents.get("/")));
  return image;
}

// --- tests ----------------------------------------------------------------------

test("ext4 walk mirrors Fat16Image pre-order DFS with leading-slash paths", async () => {
  const fs = openFixture();
  await fs.init();
  const entries = await fs.walk();
  assert.deepEqual(entries.map((e) => e.path), ["/dir/b.txt", "/a.bin", "/c.bin"]);
  assert.deepEqual(entries.map((e) => e.size), [10, 2000, 2 * BS]);
  assert.ok(entries.every((e) => !e.isDir));
});

test("ext4 readFile resolves extents, including non-contiguous ones", async () => {
  const fs = openFixture();
  await fs.init();
  const entries = await fs.walk();
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const a = await fs.readFile(byPath.get("/a.bin"));
  assert.deepEqual(a, fileData(2000, 11));
  const c = await fs.readFile(byPath.get("/c.bin"));
  const cExpected = new Uint8Array(2 * BS);
  cExpected.set(fileData(2000, 11).subarray(BS), 0); // extent 1 (file block 0 <- disk 10)
  cExpected.set(fileData(BS, 23), BS); // extent 2 (file block 1 <- disk 12)
  assert.deepEqual(c, cExpected);
  const b = await fs.readFile(byPath.get("/dir/b.txt"));
  assert.deepEqual(b, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
});

test("ext4 init rejects non-ext4 input", async () => {
  await assert.rejects(() => new Ext4Image(new BrowserFileSource(new Blob([new Uint8Array(2048)]))).init(), /ext/i);
});

test("ext4 straddling reads across extent boundaries are exact", async () => {
  const fs = openFixture();
  await fs.init();
  const entry = (await fs.walk()).find((e) => e.path === "/c.bin");
  const inodeData = await fs.readInodeData(entry.inode, entry.size);
  // every phase-shifted window equals the assembled reference
  for (let off = 0; off < 16; off++) {
    const window = await fs.readInodeRange(entry.inode, off, 100);
    assert.deepEqual(window, inodeData.subarray(off, off + 100), `offset ${off}`);
  }
});

test("ext4 walk() is memoized after init and cleared by a re-init", async () => {
  const bytes = buildExt4Fixture();
  let reads = 0;
  const counting = {
    size: bytes.length,
    async read(offset, length) {
      reads += 1;
      return bytes.subarray(offset, offset + length);
    },
  };
  const fs = new Ext4Image(counting);
  await fs.init();
  reads = 0;
  const first = await fs.walk();
  const readsAfterFirst = reads;
  assert.ok(readsAfterFirst > 0, "the first walk reads directories");
  const second = await fs.walk();
  assert.equal(reads, readsAfterFirst, "the second walk must not read");
  assert.equal(second, first, "the memoized entry array is returned as-is");
  await fs.init(); // clears the memo
  reads = 0;
  await fs.walk();
  assert.ok(reads > 0, "init() must drop the memo");
});
