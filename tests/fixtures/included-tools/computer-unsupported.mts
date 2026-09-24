Object.defineProperty(process, "platform", { value: "freebsd" });
await import("./computer-native.mts");
