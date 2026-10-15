/** Scene-wide receiver identity. Curved tags occupy [4097,8191]; planar ids
 * skip that entire band. No model is kept alive by the registry. */
export default class LumenReceiverOwners {
  constructor() {
    this.next = 1;
    this.planar = new WeakMap();
    this.curved = new WeakMap();
    this.claims = new Uint8Array(4096);
  }
  surface(model, primitive) {
    let owners = this.planar.get(model);
    if (!owners) {
      owners = new WeakMap();
      this.planar.set(model, owners);
    }
    if (!owners.has(primitive)) {
      if (this.next === 4096) this.next = 8192;
      if (this.next >= 1048576)
        throw Error("Receiver owner namespace exhausted; replace dataset");
      owners.set(primitive, this.next++);
    }
    return owners.get(primitive);
  }
  curve(model, preferred) {
    if (!Number.isInteger(preferred) || preferred <= 0 || preferred >= 4096)
      throw Error("Invalid controlled curve identity");
    let owners = this.curved.get(model);
    if (!owners) {
      owners = new Map();
      this.curved.set(model, owners);
    }
    if (!owners.has(preferred)) {
      let id = preferred;
      if (this.claims[id]) {
        id = 1;
        while (id < 4096 && this.claims[id]) id++;
      }
      if (id === 4096)
        throw Error("Controlled curve namespace exhausted; replace dataset");
      this.claims[id] = 1;
      owners.set(preferred, id);
    }
    return 4096 + owners.get(preferred);
  }
}
