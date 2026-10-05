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

// Aligned page cache for tiny reads (Step 6 of the performance review). In a
// browser every read is a Blob.slice().arrayBuffer() round trip; an ext4/FAT
// walk issues hundreds of 16 KB directory reads and thousands of <=4 KB header
// reads, which on a phone can dominate a scan/open (the reported ~2-minute
// loads: 2,100 serial reads over 18 distinct 1 MB pages). Reads are rounded to
// aligned pages held in a small LRU, so consecutive metadata reads reuse one
// fetch. Reads larger than a page (sparse scan chunks, MBN blobs) bypass the
// cache entirely. The Node benchmark cannot see this cost (fs reads are cheap),
// so the gain is browser-only and was not measurable in this environment.
export const CACHE_PAGE_SIZE = 512 * 1024; // aligned page size
export const CACHE_MAX_PAGES = 16; // ~8 MB per source

export class CachedSource {
  constructor(base, { pageSize = CACHE_PAGE_SIZE, maxPages = CACHE_MAX_PAGES } = {}) {
    this.base = base;
    this.size = base.size;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.pages = new Map(); // pageIndex -> Promise<Uint8Array> (insertion = LRU order)
  }

  #page(index) {
    const cached = this.pages.get(index);
    if (cached) {
      this.pages.delete(index); // refresh LRU position
      this.pages.set(index, cached);
      return cached;
    }
    const start = index * this.pageSize;
    const length = Math.max(0, Math.min(this.pageSize, this.size - start));
    const pending = Promise.resolve(this.base.read(start, length));
    this.pages.set(index, pending);
    // A failed page read must not be memoized (it would poison every later read).
    pending.catch(() => {
      if (this.pages.get(index) === pending) this.pages.delete(index);
    });
    while (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value);
    return pending;
  }

  async read(offset, length) {
    if (offset < 0 || length < 0) throw new RangeError(`short read at ${offset}+${length}/${this.size}`);
    if (length === 0) return new Uint8Array(0);
    // Large reads are one-shot (scan chunks, MBN payloads): go straight through.
    if (length > this.pageSize) return this.base.read(offset, length);
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const index = Math.floor(pos / this.pageSize);
      const page = await this.#page(index);
      const into = pos - index * this.pageSize;
      const n = Math.min(page.length - into, length - done);
      if (n <= 0) throw new RangeError(`short read at ${offset}+${length}/${this.size}`);
      out.set(page.subarray(into, into + n), done);
      done += n;
    }
    return out;
  }

  async close() {
    this.pages.clear();
    return this.base.close();
  }
}

// Window onto a region of a base source (sliced containers, file members).
// Closing a slice never closes the base: the outer owner owns it.
export class SlicedSource {
  constructor(base, offset, size) {
    this.base = base;
    this.offset = offset;
    this.size = size;
  }

  async read(offset, length) {
    return this.base.read(this.offset + offset, length);
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
