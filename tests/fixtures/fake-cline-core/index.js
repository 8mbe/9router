// Stand-in for @cline/core: same surface ClineFreeExecutor uses (create / subscribe
// / start / abort / stop / dispose) and the same newline-JSON envelope stream, so a
// turn can be exercised without a Cline login or network access.
export const calls = [];

export class ClineCore {
  static script = { deltas: ["Hel", "lo"], text: "Hello" };

  static async create(opts) {
    calls.push({ type: "create", opts });
    return new ClineCore();
  }

  #subscribers = new Set();

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #emit(chunk) {
    for (const fn of this.#subscribers) fn({ type: "chunk", payload: { stream: "agent", chunk } });
  }

  async start({ config, prompt, interactive }) {
    calls.push({ type: "start", config, prompt, interactive });
    for (const text of ClineCore.script.deltas) {
      this.#emit(JSON.stringify({ type: "content_delta", contentType: "text", text }));
    }
    this.#emit(JSON.stringify({ type: "done", text: ClineCore.script.text }));
    return { result: { text: ClineCore.script.text } };
  }

  async abort() { calls.push({ type: "abort" }); }
  async stop() { calls.push({ type: "stop" }); }
  async dispose() { calls.push({ type: "dispose" }); }
}
