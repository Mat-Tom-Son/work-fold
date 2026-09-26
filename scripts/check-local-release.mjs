import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalReleaseVerification, localVerificationPaths, runLocalReleaseVerification } from "./local-release-verification.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = process.argv.slice(2);
if (options.length > 1 || (options.length && options[0] !== "--status")) throw new Error("Usage: npm run desktop:release:mac:check [-- --status]");
const receipt = options.includes("--status") ? await assertLocalReleaseVerification(rootDir) : await runLocalReleaseVerification(rootDir);
console.log(JSON.stringify({ status: receipt.status, source: receipt.source, completedAt: receipt.completedAt, receipt: localVerificationPaths(rootDir).receipt, stages: receipt.stages.map(({ id, durationMs }) => ({ id, durationMs })) }, null, 2));
