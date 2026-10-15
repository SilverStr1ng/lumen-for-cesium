/** Bounded Local GI logical allocations. Keys are allocation handles, not labels.
 * Driver/allocator overhead is reported separately; reservations count against
 * the same fixed limit as committed CPU/GPU resources. */
export default class ResourceBudget {
  constructor(limit = 64 * 1048576) {
    this.limit = limit;
    this.entries = new Map();
    this.reservations = new Set();
    this.peakCommittedBytes = this.peakAdmittedBytes = 0;
  }
  observe(entries) {
    const unique = new Map();
    for (const entry of entries) {
      if (
        !entry ||
        !entry.key ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      )
        throw Error("Invalid allocation identity/size");
      const previous = unique.get(entry.key);
      if (previous && previous.bytes !== entry.bytes)
        throw Error("Conflicting allocation size");
      if (!previous) unique.set(entry.key, entry);
    }
    this.entries = unique;
    this._record();
  }
  get committedBytes() {
    return [...this.entries.values()].reduce((s, e) => s + e.bytes, 0);
  }
  get reservedBytes() {
    return [...this.reservations].reduce((s, e) => s + e.remaining, 0);
  }
  get admittedBytes() {
    return this.committedBytes + this.reservedBytes;
  }
  get planBase() {
    return (
      [...this.entries.values()].reduce(
        (s, e) =>
          s + (["fgGpu", "snapshotGpu"].includes(e.category) ? 0 : e.bytes),
        0,
      ) +
      this.reservedBytes +
      (this.extraPlanningBytes ?? 0)
    );
  }
  _record() {
    this.peakCommittedBytes = Math.max(
      this.peakCommittedBytes,
      this.committedBytes,
    );
    this.peakAdmittedBytes = Math.max(
      this.peakAdmittedBytes,
      this.admittedBytes,
    );
  }
  reserve(bytes, category) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw Error("Invalid reservation size");
    this.refresh?.();
    if (this.admittedBytes + bytes > this.limit) {
      this.onPressure?.(bytes, category);
      this.refresh?.();
    }
    if (this.admittedBytes + bytes > this.limit)
      throw new DOMException(
        `Local GI budget: ${category} needs ${bytes}B; admitted ${this.admittedBytes}/${this.limit}B`,
        "QuotaExceededError",
      );
    const reservation = { category, bytes, remaining: bytes };
    this.reservations.add(reservation);
    this._record();
    let closed = false;
    return {
      cover: (committed) => {
        if (closed) return;
        reservation.remaining = Math.max(0, bytes - committed);
        // Inventory and consumed capacity publish together in observe().
        // Recording here would combine new capacity with stale freed handles.
      },
      commit: () => {
        if (closed) return;
        closed = true;
        this.reservations.delete(reservation);
        this.refresh?.();
        this._record();
      },
      release: () => {
        closed = true;
        this.reservations.delete(reservation);
      },
    };
  }
  tryReserve(bytes, category) {
    this.refresh?.();
    return this.admittedBytes + bytes <= this.limit
      ? this.reserve(bytes, category)
      : undefined;
  }
  report() {
    const categories = {};
    for (const e of this.entries.values())
      categories[e.category] = (categories[e.category] ?? 0) + e.bytes;
    return {
      budget: this.limit,
      categories,
      allocations: this.entries.size,
      knownAdditionalBytes: this.committedBytes,
      reservedBytes: this.reservedBytes,
      admittedBytes: this.admittedBytes,
      peakKnownBytes: this.peakCommittedBytes,
      peakAdmittedBytes: this.peakAdmittedBytes,
      driverVram: "not-run",
      jsAllocator: "not-run",
    };
  }
}
