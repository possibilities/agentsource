/** Byte-bounded NDJSON; decode whole frames so fragmented UTF-8 is preserved. */
export class JsonLines {
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  constructor(readonly limit: number) {}
  push(chunk: Buffer, receive: (value: unknown) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      const total = this.#bytes + piece.length;
      if (total > this.limit) throw new Error("NDJSON frame exceeds byte limit");
      if (total > this.#buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(this.limit, Math.max(total, this.#buffer.length * 2, 4096)),
        );
        this.#buffer.copy(grown, 0, 0, this.#bytes);
        this.#buffer = grown;
      }
      piece.copy(this.#buffer, this.#bytes);
      this.#bytes = total;
      if (newline < 0) return;
      const line = new TextDecoder("utf-8", { fatal: true }).decode(
        this.#buffer.subarray(0, total),
      );
      this.#bytes = 0;
      // Release large allocations after a completed frame; tiny fragments cannot
      // create an unbounded list of retained Buffer views.
      this.#buffer = Buffer.alloc(0);
      receive(JSON.parse(line));
      offset = newline + 1;
    }
  }
}
