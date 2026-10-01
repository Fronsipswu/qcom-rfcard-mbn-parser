// RandomAccessSource: the ONLY way code touches image bytes.
// Contract: read(offset, length) -> Promise<Uint8Array> of exactly `length` bytes
// (short reads throw RangeError); slices must be small (boot sector, FAT table,
// dir entries, MBN buffers, 1MB scan chunks).
// Constructors cannot await fs calls, so NodeFileSource.open() and sourceFor()
// are the async factories; NodeFileSource wraps an already-open fs.promises handle.
export class NodeFileSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  // Opens a path or file:// URL (or wraps an open FileHandle); stats the file unless size is given.
  static async open(pathOrHandle, size) {
    if (typeof process === "undefined") throw new Error("NodeFileSource requires Node");
    const fsp = await import("node:fs/promises");
    const isPath = typeof pathOrHandle === "string" || pathOrHandle instanceof URL;
    const handle = isPath ? await fsp.open(pathOrHandle, "r") : pathOrHandle;
    if (size === undefined) size = (await handle.stat()).size;
    return new NodeFileSource(handle, size);
  }

  async read(offset, length) {
    const { buffer, bytesRead } = await this.handle.read(Buffer.alloc(length), 0, length, offset);
    if (bytesRead < length) throw new RangeError(`short read at ${offset}+${length}/${this.size} (got ${bytesRead})`);
    return buffer; // Buffer is a Uint8Array; exact-size alloc, no view math needed
  }

  async close() {
    await this.handle.close();
  }
}

export class BrowserFileSource {
  constructor(file) {
    this.file = file;
    this.size = file.size;
  }

  async read(offset, length) {
    const buf = await this.file.slice(offset, offset + length).arrayBuffer();
    if (buf.byteLength < length) throw new RangeError(`short read at ${offset}+${length}/${this.size}`);
    return new Uint8Array(buf);
  }

  async close() {}
}

export async function sourceFor(target) {
  // string/path-like -> Node fs handle source; File/Blob (slice + size) -> browser slice source
  if (typeof target === "string" || target instanceof URL) {
    return NodeFileSource.open(target);
  }
  if (target && typeof target.slice === "function" && typeof target.size === "number") {
    return new BrowserFileSource(target);
  }
  throw new TypeError(`no RandomAccessSource for ${typeof target}`);
}
