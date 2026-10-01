// Read-only FAT16 reader for Qualcomm modem images; port of Fat16Image
// (legacy_rf_parser.py:155-372) and _walk_fat (qualcomm_rf_combo_analyzer.py:139-158).
// Works on any RandomAccessSource (source.js): read(offset, length) -> Promise<Uint8Array>.
import { StructReader } from "./bytes.js";
import { cp437Decode } from "./cp437.js";

// Same role as ParseError in legacy_rf_parser.py.
export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

export class Fat16Image {
  constructor(source) {
    this.source = source;
  }

  // Reads boot sector (512B) + first FAT table only; constructors cannot await.
  async init() {
    let boot;
    try {
      boot = await this.source.read(0, 512);
    } catch (err) {
      if (err instanceof RangeError) throw new ParseError("Input is too small to be a FAT filesystem.");
      throw err;
    }
    const r = new StructReader(boot);
    this.bytesPerSector = r.u16(11);
    this.sectorsPerCluster = r.u8(13);
    this.reservedSectors = r.u16(14);
    this.fatCount = r.u8(16);
    this.rootEntryCount = r.u16(17);
    const total16 = r.u16(19);
    this.sectorsPerFat = r.u16(22);
    const total32 = r.u32(32);
    this.totalSectors = total16 || total32;

    if (
      ![512, 1024, 2048, 4096].includes(this.bytesPerSector) ||
      this.sectorsPerCluster === 0 ||
      this.fatCount === 0 ||
      this.rootEntryCount === 0 ||
      this.sectorsPerFat === 0 ||
      this.totalSectors === 0
    ) {
      throw new ParseError("Input is not a supported FAT16 filesystem.");
    }

    const rootBytes = this.rootEntryCount * 32;
    this.rootDirSectors = Math.floor((rootBytes + this.bytesPerSector - 1) / this.bytesPerSector);
    this.fatOffset = this.reservedSectors * this.bytesPerSector;
    this.rootOffset = (this.reservedSectors + this.fatCount * this.sectorsPerFat) * this.bytesPerSector;
    this.dataOffset =
      (this.reservedSectors + this.fatCount * this.sectorsPerFat + this.rootDirSectors) * this.bytesPerSector;
    this.clusterSize = this.bytesPerSector * this.sectorsPerCluster;

    const dataSectors =
      this.totalSectors - this.reservedSectors - this.fatCount * this.sectorsPerFat - this.rootDirSectors;
    const clusterCount = Math.floor(dataSectors / this.sectorsPerCluster);
    if (!(4085 <= clusterCount && clusterCount < 65525)) {
      throw new ParseError(`Filesystem has ${clusterCount} data clusters; FAT16 expected.`);
    }

    try {
      this.fat = await this.source.read(this.fatOffset, this.sectorsPerFat * this.bytesPerSector);
    } catch (err) {
      if (err instanceof RangeError) throw new ParseError("FAT table is shorter than the declared filesystem.");
      throw err;
    }
    if (this.fat.length < (clusterCount + 2) * 2) {
      throw new ParseError("FAT table is shorter than the declared filesystem.");
    }
  }

  #clusterOffset(cluster) {
    if (cluster < 2) throw new ParseError(`Invalid FAT16 cluster ${cluster}.`);
    return this.dataOffset + (cluster - 2) * this.clusterSize;
  }

  #clusterChain(firstCluster) {
    const chain = [];
    const seen = new Set();
    const fat = new StructReader(this.fat);
    let cluster = firstCluster;
    while (2 <= cluster && cluster < 0xfff8) {
      if (seen.has(cluster)) throw new ParseError(`FAT16 cluster chain loops at ${cluster}.`);
      if (cluster * 2 + 2 > this.fat.length) throw new ParseError(`FAT16 cluster ${cluster} is outside the FAT.`);
      seen.add(cluster);
      chain.push(cluster);
      cluster = fat.u16(cluster * 2);
      if (cluster === 0xfff7) throw new ParseError("FAT16 cluster chain contains a bad cluster.");
      if (cluster === 0 || cluster === 1) throw new ParseError("FAT16 cluster chain ended unexpectedly.");
    }
    return chain;
  }

  async #readClusters(firstCluster) {
    const chain = this.#clusterChain(firstCluster);
    const out = new Uint8Array(chain.length * this.clusterSize);
    let off = 0;
    for (const cluster of chain) {
      let chunk;
      try {
        chunk = await this.source.read(this.#clusterOffset(cluster), this.clusterSize);
      } catch (err) {
        if (err instanceof RangeError) throw new ParseError("FAT16 cluster extends beyond the image.");
        throw err;
      }
      out.set(chunk, off);
      off += this.clusterSize;
    }
    return out;
  }

  // 8.3 name: cp437, trailing spaces stripped, 0x05 escape stands for a real 0xE5 byte.
  #shortName(raw) {
    const base = raw.slice(0, 8);
    const ext = raw.slice(8, 11);
    if (base.length > 0 && base[0] === 0x05) base[0] = 0xe5;
    const baseText = cp437Decode(base).trimEnd(); // Python .rstrip()
    const extText = cp437Decode(ext).trimEnd();
    return baseText + (extText ? `.${extText}` : "");
  }

  async #directoryBytes(firstCluster) {
    if (firstCluster === null) {
      const size = this.rootEntryCount * 32;
      let data;
      try {
        data = await this.source.read(this.rootOffset, size);
      } catch (err) {
        if (err instanceof RangeError) throw new ParseError("FAT16 root directory extends beyond the image.");
        throw err;
      }
      return data;
    }
    return this.#readClusters(firstCluster);
  }

  async #listDirectory(firstCluster) {
    const data = await this.#directoryBytes(firstCluster);
    const entries = [];
    const lfnParts = new Map();
    for (let off = 0; off + 32 <= data.length; off += 32) {
      const raw = data.subarray(off, off + 32);
      if (raw[0] === 0x00) break; // end-of-directory
      if (raw[0] === 0xe5) {
        lfnParts.clear(); // deleted entry discards pending LFN parts
        continue;
      }
      if (raw[11] === 0x0f) {
        // LFN: <5H>@1 + <6H>@14 + <2H>@28 UTF-16 units; stored last-ordinal-first on disk
        const ordinal = raw[0] & 0x1f;
        if (ordinal === 0) {
          lfnParts.clear();
          continue;
        }
        const r = new StructReader(raw);
        const units = [...r.unpack("<5H", 1), ...r.unpack("<6H", 14), ...r.unpack("<2H", 28)];
        let chars = "";
        for (const unit of units) {
          if (unit === 0x0000 || unit === 0xffff) break;
          chars += String.fromCharCode(unit);
        }
        lfnParts.set(ordinal, chars);
        continue;
      }
      const attributes = raw[11];
      if (attributes & 0x08) {
        lfnParts.clear(); // volume label
        continue;
      }
      const name = lfnParts.size
        ? [...lfnParts.keys()].sort((a, b) => a - b).map((k) => lfnParts.get(k)).join("")
        : this.#shortName(raw);
      lfnParts.clear();
      const r = new StructReader(raw);
      entries.push({
        name,
        attributes,
        firstCluster: r.u16(26),
        size: r.u32(28),
        isDir: (attributes & 0x10) !== 0,
      });
    }
    return entries;
  }

  // Pre-order DFS mirroring _walk_fat: descend into a directory as soon as it is
  // seen; only files are yielded. `seen` guards against directory loops.
  async walk() {
    if (!this.fat) throw new ParseError("Fat16Image not initialised: call await init() before walk().");
    const out = [];
    const seen = new Set();
    const visit = async (directoryCluster, parent) => {
      if (directoryCluster !== null) {
        if (seen.has(directoryCluster)) return;
        seen.add(directoryCluster);
      }
      for (const entry of await this.#listDirectory(directoryCluster)) {
        if (entry.name === "." || entry.name === "..") continue;
        const path = `${parent}/${entry.name}`;
        if (entry.isDir) await visit(entry.firstCluster, path);
        else out.push({ path, firstCluster: entry.firstCluster, size: entry.size, isDir: entry.isDir });
      }
    };
    await visit(null, "");
    return out;
  }

  async readFile(entry) {
    if (entry.isDir) {
      throw new ParseError(`Path is a directory inside modem.img: ${entry.path ?? entry.name}`);
    }
    if (entry.size === 0) return new Uint8Array(0);
    const data = await this.#readClusters(entry.firstCluster);
    if (data.length < entry.size) {
      throw new ParseError(`FAT16 file is truncated: ${entry.path ?? entry.name}`);
    }
    return data.slice(0, entry.size);
  }
}
