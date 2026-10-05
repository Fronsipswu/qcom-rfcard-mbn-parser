// Read-only ext4 walker, sized to what the container layer needs: enumerate
// the file tree and read file bytes through extent trees. The corpus forces
// this file into existence: radio.img's sparse payload is an ext4 filesystem
// (verified with dumpe2fs: features extent/64bit/flex_bg/sparse_super/
// large_file/huge_file/dir_nlink/extra_isize/metadata_csum, 128-byte inodes),
// and the golden inner_path `sparse/image/...` shows 7-Zip extracted the ext4
// tree directly into the sparse scratch dir. The FAT 7z fallback was deleted
// in favor of Fat16Image; this replaces the ext4 debugfs fallback the same way.
//
// Deliberately unsupported (not reachable in the corpus): traditional block
// pointer inodes, inline_data, bigalloc, casefolded/encrypted dirs. Directory
// blocks are scanned linearly, which also covers htree directories (entries
// stay in the leaf blocks).
import { StructReader } from "./bytes.js";
import { ParseError } from "./fat16.js";
import { bump } from "./debug.js";

const EXT2_SUPER_MAGIC = 0xef53;
const EXT4_EXTENTS_FL = 0x80000;
const EXT4_EXT_MAGIC = 0xf30a;

const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_EXTENTS = 0x40;
const INCOMPAT_64BIT = 0x80;
const INCOMPAT_INLINE_DATA = 0x8000;
const INCOMPAT_BIGALLOC = 0x1000;

const FT_REG_FILE = 1;
const FT_DIR = 2;

export class Ext4Image {
  constructor(source) {
    this.source = source;
  }

  async init() {
    // Superblock lives 1024 bytes into the device.
    let sb;
    try {
      sb = await this.source.read(1024, 1024);
    } catch (err) {
      if (err instanceof RangeError) throw new ParseError("Input is too small to be an ext filesystem.");
      throw err;
    }
    const r = new StructReader(sb);
    if (r.u16(0x38) !== EXT2_SUPER_MAGIC) {
      throw new ParseError("Input is not an ext2/3/4 filesystem (superblock magic).");
    }
    const blockSize = 1 << (10 + r.u32(0x18));
    this.blockSize = blockSize;
    this.firstDataBlock = r.u32(0x14);
    this.blocksCount = r.u32(0x04) + r.u32(0x150) * 2 ** 32;
    this.inodesPerGroup = r.u32(0x28);
    this.inodeSize = r.u16(0x58);
    this.revLevel = r.u32(0x4c);
    this.descSize = this.revLevel >= 1 && r.u16(0xfe) ? r.u16(0xfe) : 32;
    const incompat = r.u32(0x60);
    if (incompat & INCOMPAT_BIGALLOC) throw new ParseError("ext4 bigalloc is not supported.");
    if (incompat & INCOMPAT_INLINE_DATA) throw new ParseError("ext4 inline_data is not supported.");
    if (!(incompat & INCOMPAT_EXTENTS)) throw new ParseError("ext4 images without extents are not supported.");
    this.filetype = (incompat & INCOMPAT_FILETYPE) !== 0;
    this.desc64 = (incompat & INCOMPAT_64BIT) !== 0;
    const groups = Math.ceil((this.blocksCount - this.firstDataBlock) / r.u32(0x20));
    this.groups = groups;
    // Group descriptor table: block first_data_block + 1.
    const gdtOffset = (this.firstDataBlock + 1) * blockSize;
    const gdt = await this.source.read(gdtOffset, groups * this.descSize);
    this.groups_ = [];
    const g = new StructReader(gdt);
    for (let i = 0; i < groups; i++) {
      const base = i * this.descSize;
      const desc = {
        blockBitmap: g.u32(base) + (this.desc64 ? g.u32(base + 0x20) * 2 ** 32 : 0),
        inodeBitmap: g.u32(base + 4) + (this.desc64 ? g.u32(base + 0x24) * 2 ** 32 : 0),
        inodeTable: g.u32(base + 8) + (this.desc64 ? g.u32(base + 0x28) * 2 ** 32 : 0),
      };
      this.groups_.push(desc);
    }
    this.inodesPerGroup_ = this.inodesPerGroup;
  }

  #assertInit() {
    if (!this.groups_) throw new ParseError("Ext4Image not initialised: call await init() first.");
  }

  // Reads the raw 128..1024-byte inode structure (1-based inode number).
  async readInodeStruct(ino) {
    this.#assertInit();
    if (ino < 1 || ino > this.groups * this.inodesPerGroup_) throw new ParseError(`ext4 inode ${ino} is out of range.`);
    const group = Math.floor((ino - 1) / this.inodesPerGroup_);
    const index = (ino - 1) % this.inodesPerGroup_;
    const tableBlock = this.groups_[group].inodeTable;
    return this.source.read(tableBlock * this.blockSize + index * this.inodeSize, this.inodeSize);
  }

  // Resolves an inode's extent tree into disk-block runs.
  // Returns [{ fileBlock, diskBlock, blocks }].
  async #extents(inodeStruct) {
    const r = new StructReader(inodeStruct);
    const flags = r.u32(0x20);
    if (flags & 0x800000) throw new ParseError("ext4 inline_data inode is not supported.");
    if (!(flags & EXT4_EXTENTS_FL)) throw new ParseError("ext4 inode without extents is not supported.");
    const size = r.u32(4) + r.u32(0x6c) * 2 ** 32;
    const root = inodeStruct.subarray(40, 100);
    const out = [];
    const visit = async (nodeBytes) => {
      const nr = new StructReader(nodeBytes);
      if (nr.u16(0) !== EXT4_EXT_MAGIC) throw new ParseError("Corrupt ext4 extent header.");
      const entries = nr.u16(2);
      const depth = nr.u16(6);
      for (let i = 0; i < entries; i++) {
        const off = 12 + i * 12;
        if (depth === 0) {
          const fileBlock = nr.u32(off);
          let len = nr.u16(off + 4);
          let diskBlock = nr.u32(off + 8) + nr.u16(off + 6) * 2 ** 32;
          if (len > 32768) {
            // Uninitialized extent: reads as zeros.
            len -= 32768;
            diskBlock = -1;
          }
          out.push({ fileBlock, diskBlock, blocks: len });
        } else {
          const leaf = nr.u32(off + 4) + nr.u16(off + 8) * 2 ** 32;
          await visit(await this.source.read(leaf * this.blockSize, this.blockSize));
        }
      }
    };
    await visit(root);
    return { extents: out, size };
  }

  // Reads `length` bytes of inode data starting at `offset`. Gaps between (or
  // before) extents are holes and read as zeros - modem images carry sparse
  // directory/files whose extents skip blocks (radio.img inode 43 does).
  async readInodeRange(ino, offset, length) {
    const inodeStruct = await this.readInodeStruct(ino);
    const { extents, size } = await this.#extents(inodeStruct);
    if (offset + length > size) throw new RangeError(`ext4 read beyond inode ${ino} size: ${offset}+${length}/${size}`);
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const run = extents.find((e) => pos >= e.fileBlock * this.blockSize && pos < (e.fileBlock + e.blocks) * this.blockSize);
      let n;
      if (!run || run.diskBlock === -1) {
        // Hole (or uninitialized extent): zeros until the next real extent.
        let holeEnd = offset + length;
        if (run) {
          holeEnd = Math.min(holeEnd, (run.fileBlock + run.blocks) * this.blockSize);
        } else {
          const next = extents
            .map((e) => e.fileBlock * this.blockSize)
            .filter((b) => b > pos)
            .sort((a, b) => a - b)[0];
          if (next !== undefined) holeEnd = Math.min(holeEnd, next);
        }
        n = holeEnd - pos; // out is already zero-filled
      } else {
        const into = pos - run.fileBlock * this.blockSize;
        n = Math.min(run.blocks * this.blockSize - into, length - done);
        out.set(await this.source.read(run.diskBlock * this.blockSize + into, n), done);
      }
      done += n;
    }
    return out;
  }

  async readInodeData(ino, size) {
    return this.readInodeRange(ino, 0, size);
  }

  // Pre-order DFS mirroring Fat16Image.walk/_walk_fat: descend into a directory
  // as soon as it is seen; only files are yielded; paths start with "/".
  async walk() {
    this.#assertInit();
    bump("ext4Walk");
    const out = [];
    const visit = async (dirIno, parent) => {
      const inodeStruct = await this.readInodeStruct(dirIno);
      const { size } = await this.#extents(inodeStruct);
      // Read the whole directory through the extent map (holes read as zeros;
      // entries never live in holes).
      const data = size > 0 ? await this.readInodeRange(dirIno, 0, size) : new Uint8Array(0);
      let off = 0;
      while (off + 8 <= data.length) {
        const r = new StructReader(data);
        const entryIno = r.u32(off);
        const recLen = r.u16(off + 4);
        if (recLen < 8) break;
        const nameLen = data[off + 6];
        const fileType = this.filetype ? data[off + 7] : 0;
        if (entryIno !== 0 && off + 8 + nameLen <= data.length) {
          const name = String.fromCharCode(...data.subarray(off + 8, off + 8 + nameLen));
          if (name !== "." && name !== "..") {
            const path = `${parent}/${name}`;
            if (fileType === FT_DIR || (fileType === 0 && (await this.#modeIsDir(entryIno)))) {
              await visit(entryIno, path);
            } else if (fileType === FT_REG_FILE || fileType === 0) {
              const child = new StructReader(await this.readInodeStruct(entryIno));
              out.push({ path, inode: entryIno, size: child.u32(4) + child.u32(0x6c) * 2 ** 32, isDir: false });
            }
          }
        }
        off += recLen;
      }
    };
    await visit(2, "");
    return out;
  }

  async #modeIsDir(ino) {
    const r = new StructReader(await this.readInodeStruct(ino));
    return (r.u16(0) & 0xf000) === 0x4000;
  }

  // Exact-path lookup over walk(); null when absent.
  async findFile(path) {
    this.#assertInit();
    const entries = await this.walk();
    return entries.find((e) => e.path === path) ?? null;
  }

  // Size-truncated read like Fat16Image.readFile (callers own the truncation
  // semantics; here the inode size IS the truth, so no truncation happens).
  async readFile(entry) {
    if (entry.isDir) throw new ParseError(`Path is a directory inside the ext4 filesystem: ${entry.path ?? entry.name}`);
    if (entry.size === 0) return new Uint8Array(0);
    return this.readInodeRange(entry.inode, 0, entry.size);
  }
}
