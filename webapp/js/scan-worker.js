// Apple CR bank scan unit worker. The scan coordinator (worker.js) fans the
// ftab's banks out to a pool of these: one bank per task = {type:"appleBank"}
// with the bank's COMPRESSED stream transferred zero-copy as an ArrayBuffer.
// The unit does the only per-bank work that matters (measured: 99% of scan
// time is the LZFSE decode; sha256/inspect are ~1%) and replies with the small
// inspect payload the coordinator folds into its record, in descriptor order.
//
// main -> unit:  { type: "appleBank", id, stream(ArrayBuffer), uncompSize }
// unit -> main:  { type: "appleBankResult", id, ok: true, appleInfo }
//              | { type: "appleBankResult", id, ok: false, message }
import { lzfseDecode } from "./lib/lzfse.js";
import { inspectAppleBank } from "./lib/apple_cr.js";

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "appleBank") return;
  try {
    const bank = lzfseDecode(new Uint8Array(msg.stream), msg.uncompSize);
    const inspected = inspectAppleBank(bank);
    self.postMessage({
      type: "appleBankResult",
      id: msg.id,
      ok: true,
      appleInfo: {
        layout: inspected.layout,
        counts: {
          lte: inspected.lteCount,
          endc: inspected.endcCount,
          nrca: inspected.nrcaCount,
          nrdc: inspected.nrdcCount,
        },
      },
    });
  } catch (err) {
    self.postMessage({
      type: "appleBankResult",
      id: msg.id,
      ok: false,
      message: err && err.message ? err.message : String(err),
    });
  }
};
