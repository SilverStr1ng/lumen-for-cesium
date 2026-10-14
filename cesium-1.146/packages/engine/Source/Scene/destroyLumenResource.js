import { destroyObject } from "@cesium/core";
/** Bridge private ES6 resource classes to Cesium's enumerable-method guard.
 * Core destroyObject otherwise skips non-enumerable class prototype methods.
 * @private */
export default function destroyLumenResource(resource) {
  for (const name of Object.getOwnPropertyNames(
    Object.getPrototypeOf(resource),
  )) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(resource),
      name,
    );
    if (name !== "constructor" && typeof descriptor.value === "function") {
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
