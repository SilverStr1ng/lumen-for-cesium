/** One frozen operation plus one latest pending target. No unbounded solve queue. */
export class LatestRequests {
  constructor(run) {
    this.run = run;
    this.nextId = 0;
    this.closed = false;
  }
  submit(value) {
    if (this.closed) return Promise.resolve({ outcome: "cancelled" });
    return new Promise((resolve, reject) => {
      const request = { id: ++this.nextId, value, resolve, reject };
      if (this.pending)
        this.pending.resolve({
          outcome: "superseded",
          requestId: this.pending.id,
          supersededBy: request.id,
        });
      this.pending = request;
      this._drain();
    });
  }
  async _drain() {
    if (this.active || this.closed) return;
    while (this.pending && !this.closed) {
      const request = (this.active = this.pending);
      this.pending = undefined;
      try {
        const result = await this.run(request.value, request.id);
        if (!this.closed)
          request.resolve({
            ...result,
            outcome: "completed",
            requestId: request.id,
          });
      } catch (error) {
        if (!this.closed) request.reject(error);
      } finally {
        this.active = undefined;
      }
    }
  }
  close(reason = "dataset replaced, cancelled or disposed") {
    this.closed = true;
    for (const request of [this.active, this.pending])
      request?.resolve({ outcome: "cancelled", requestId: request.id, reason });
    this.pending = undefined;
  }
}

export function afterFrame(scene, action, signal, timeoutMilliseconds = 5000) {
  return new Promise((resolve, reject) => {
    let remove;
    const clean = () => {
      clearTimeout(timer);
      remove?.();
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      clean();
      reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      clean();
      reject(
        new DOMException(
          "No postRender: render loop stopped, hidden or Scene unavailable",
          "TimeoutError",
        ),
      );
    }, timeoutMilliseconds);
    remove = scene.postRender.addEventListener(() => {
      clean();
      try {
        resolve(action?.());
      } catch (error) {
        reject(error);
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else if (scene.isDestroyed()) {
      clean();
      reject(Error("Scene destroyed"));
    } else scene.requestRender();
  });
}
