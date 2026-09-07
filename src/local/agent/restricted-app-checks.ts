import { restrictedAppCheckLimits, type RestrictedAppCheckGrant, type RestrictedAppCheckPermission, type RestrictedAppCheckResult } from "../../shared/restricted-app-checks.js";

export type RestrictedAppCheckReader = (spaceId: string, checkId: string, declarationDigest: string) => Promise<RestrictedAppCheckResult>;

export class RestrictedAppCheckError extends Error {
  constructor(readonly code: "CHECK_DENIED" | "CHECK_UNAVAILABLE", message: string) { super(message); }
}

/** Sender identity and a current effect lease must come from the host, never request JSON. */
export async function readRestrictedAppCheck(context: {
  spaceId: string;
  declarations: readonly RestrictedAppCheckPermission[];
  grants: readonly RestrictedAppCheckGrant[];
  read: RestrictedAppCheckReader;
  assertCurrent: () => void;
}, request: unknown): Promise<RestrictedAppCheckResult> {
  context.assertCurrent();
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== 1 || !("permissionId" in request)
    || typeof request.permissionId !== "string") throw new RestrictedAppCheckError("CHECK_DENIED", "Choose a declared Check permission.");
  const permission = context.declarations.find((item) => item.id === request.permissionId);
  const grant = context.grants.find((item) => item.permissionId === permission?.id);
  if (!permission || !grant) throw new RestrictedAppCheckError("CHECK_DENIED", "Choose a Check in this app's Apps settings first.");
  let result: RestrictedAppCheckResult;
  try { result = await context.read(context.spaceId, grant.checkId, grant.declarationDigest); }
  catch { throw new RestrictedAppCheckError("CHECK_UNAVAILABLE", "The selected Check is unavailable or changed. Review its selection in Apps."); }
  context.assertCurrent();
  if (result.checkId !== grant.checkId || result.declarationDigest !== grant.declarationDigest
    || Buffer.byteLength(JSON.stringify(result), "utf8") > restrictedAppCheckLimits.resultBytes) {
    throw new RestrictedAppCheckError("CHECK_UNAVAILABLE", "The selected Check result is unavailable.");
  }
  return structuredClone(result);
}
