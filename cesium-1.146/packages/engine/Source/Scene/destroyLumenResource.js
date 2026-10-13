import { destroyObject } from "@cesium/core";
/** Bridge private ES6 resource classes to Cesium's enumerable-method guard.
 * Core destroyObject otherwise skips non-enumerable class prototype methods.
 * @private */
export default function destroyLumenResource(resource) {
  for (const name of Object.getOwnPropertyNames(
    Object.getPrototypeOf(resource),
  )) {
    if (name !== "constructor" && typeof resource[name] === "function") {
      Object.defineProperty(resource, name, {
        value: resource[name],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
  return destroyObject(resource);
}
