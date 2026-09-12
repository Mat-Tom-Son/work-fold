import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebAccessExtension } from "pi-web-access/embedded.ts";
import { hostContext } from "../host.ts";

export default function web(pi: ExtensionAPI) {
  const host = hostContext(pi);
  return createWebAccessExtension(host ? { getSearchConfig: host.getSearchConfig } : {})(pi);
}
