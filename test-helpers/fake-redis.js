export class FakeRedis {
  constructor() {
    this.values = new Map();
    this.calls = [];
  }

  async command(command, ...parts) {
    const operation = String(command).toUpperCase();
    this.calls.push([operation, ...structuredClone(parts)]);

    if (operation === "GET") {
      return this.values.has(parts[0]) ? this.values.get(parts[0]) : null;
    }
    if (operation === "SET") {
      const [key, value, ...options] = parts;
      const normalizedOptions = options.map((option) => String(option).toUpperCase());
      if (normalizedOptions.includes("NX") && this.values.has(key)) return null;
      this.values.set(key, value);
      return "OK";
    }
    if (operation === "EVAL") {
      const [, keyCount, key, token] = parts;
      if (Number(keyCount) !== 1) throw new Error("FakeRedis only supports one-key scripts.");
      if (this.values.get(key) !== token) return 0;
      this.values.delete(key);
      return 1;
    }
    throw new Error(`Unsupported fake Redis command: ${operation}`);
  }
}
