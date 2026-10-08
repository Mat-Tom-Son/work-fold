import { createLucideIcon } from "lucide-react";

/*!
 * Globe Code from Lucide, pinned to a04f228cd01185e09c188b7227b9600c08c565ec.
 * https://github.com/lucide-icons/lucide/blob/a04f228cd01185e09c188b7227b9600c08c565ec/icons/globe-code.svg
 * ISC License — Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
// This requested icon is newer than our installed Lucide package. Keep the
// upstream paths here so this UI change does not require a dependency upgrade.
export const GlobeCode = createLucideIcon("GlobeCode", [
  ["path", { d: "M15.5 10 13 7.5 15.5 5", key: "code-left" }],
  ["path", { d: "M15.861 14A14.5 14.5 0 0112 22a14.48 14.48 0 010-20 10 10 0 109.888 11.5", key: "globe" }],
  ["path", { d: "M19.5 5 22 7.5 19.5 10", key: "code-right" }],
  ["path", { d: "M2 12h8.5", key: "equator" }],
]);
