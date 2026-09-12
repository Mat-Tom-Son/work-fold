Object.defineProperty(process, "platform", { value: "linux" });
await import("./computer-native.mts");
