import "@testing-library/jest-dom/vitest";

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.has(key) ? storage.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

const storageCandidate = globalThis.localStorage as Partial<Storage> | undefined;
const hasStorageApi =
  typeof storageCandidate?.getItem === "function" &&
  typeof storageCandidate?.setItem === "function" &&
  typeof storageCandidate?.removeItem === "function" &&
  typeof storageCandidate?.clear === "function";

if (!hasStorageApi) {
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
