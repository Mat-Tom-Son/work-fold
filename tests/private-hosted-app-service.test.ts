import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrincipalId,
  createCloudProjectId,
  createProjectId,
  createTenantId,
  type EffectivePrincipal,
  type CloudProjectId,
  type PrincipalId,
  type ProjectId,
  type TenantId,
} from "../src/local/agent/app-platform-contract.js";
import {
  assembleAppRelease,
  type AppReleaseEnvelope,
} from "../src/local/agent/app-platform-release.js";
import {
  HostedAppPlatformError,
  PrivateHostedAppService,
  type HostedConnectionEffectBroker,
  type HostedCloudProjectRegistry,
  type HostedDurableStateRepository,
  type HostedJobCoordinator,
  type HostedInstanceRevocationHighWater,
  type HostedInstanceRevocationMarker,
  type HostedPrincipalAuthenticator,
  type HostedSecretVault,
} from "../src/local/agent/private-hosted-app-service.js";

const encoder = new TextEncoder();

class FixtureAuthenticator implements HostedPrincipalAuthenticator {
  constructor(readonly principals: ReadonlyMap<string, EffectivePrincipal>) {}

  authenticate(authentication: string): unknown {
    return this.principals.get(authentication) ?? null;
  }
}

class FixtureCloudProjectRegistry implements HostedCloudProjectRegistry {
  constructor(readonly bindings: ReadonlyMap<ProjectId, CloudProjectId>) {}

  resolveBinding(input: Parameters<HostedCloudProjectRegistry["resolveBinding"]>[0]): unknown {
    return this.bindings.get(input.projectId) ?? null;
  }
}

class FixtureVault implements HostedSecretVault {
  readonly values = new Map<string, Uint8Array>();
  readonly bindings = new Map<string, Parameters<HostedSecretVault["store"]>[1]>();
  readonly destroyed: string[] = [];
  readonly operationRefs = new Map<string, string>();
  readonly cancelledStoreOperations = new Set<string>();
  #next = 1;
  failDestroy = false;
  failCancelStore = false;
  beforeStore?: () => void;
  afterStore?: () => void;

  store(secret: Uint8Array, binding: Parameters<HostedSecretVault["store"]>[1]): string {
    this.beforeStore?.();
    if (this.cancelledStoreOperations.has(binding.operationId)) throw new Error("store operation was durably cancelled");
    const existing = this.operationRefs.get(binding.operationId);
    if (existing) return existing;
    const ref = `vault-ref-${this.#next++}`;
    this.values.set(ref, new Uint8Array(secret));
    this.bindings.set(ref, structuredClone(binding));
    this.operationRefs.set(binding.operationId, ref);
    this.afterStore?.();
    return ref;
  }

  destroy(secretRef: string): void {
    if (this.failDestroy) throw new Error("injected vault cleanup failure");
    this.values.delete(secretRef);
    this.bindings.delete(secretRef);
    this.destroyed.push(secretRef);
  }

  cancelStore(operationId: string): void {
    if (this.failCancelStore) throw new Error("injected vault operation cancellation failure");
    this.cancelledStoreOperations.add(operationId);
    const secretRef = this.operationRefs.get(operationId);
    if (!secretRef) return;
    this.destroy(secretRef);
    this.operationRefs.delete(operationId);
  }
}

class FixtureBroker implements HostedConnectionEffectBroker {
  effectCount = 0;
  readonly secretRefs: string[] = [];
  readonly inputs: Parameters<HostedConnectionEffectBroker["execute"]>[0][] = [];
  readonly idempotencyKeys = new Set<string>();
  beforeAuthorize?: (input: Parameters<HostedConnectionEffectBroker["execute"]>[0]) => void;
  afterEffect?: (input: Parameters<HostedConnectionEffectBroker["execute"]>[0]) => void;

  async execute(input: Parameters<HostedConnectionEffectBroker["execute"]>[0]): Promise<void> {
    this.beforeAuthorize?.(input);
    input.authorizeEffect();
    this.inputs.push(structuredClone({ ...input, authorizeEffect: undefined }) as never);
    if (this.idempotencyKeys.has(input.idempotencyKey)) return;
    this.idempotencyKeys.add(input.idempotencyKey);
    this.secretRefs.push(input.secretRef);
    this.effectCount += 1;
    this.afterEffect?.(input);
  }
}

class FixtureStateRepository implements HostedDurableStateRepository {
  state: unknown | undefined;
  failNextCommit = false;
  staleNextCommit = false;
  afterNextCommit?: () => void;

  load(): unknown | undefined {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  compareAndSwap(expectedRevision: number, nextState: unknown): void {
    const currentRevision = this.state === undefined
      ? 0
      : (this.state as { revision: number }).revision;
    if (currentRevision !== expectedRevision) throw new Error("state conflict");
    if (this.staleNextCommit) {
      this.staleNextCommit = false;
      const winner = structuredClone(this.state) as { revision: number };
      winner.revision += 1;
      this.state = winner;
      throw new Error("injected stale compare-and-swap");
    }
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("injected durable commit failure");
    }
    this.state = structuredClone(nextState);
    const afterCommit = this.afterNextCommit;
    this.afterNextCommit = undefined;
    afterCommit?.();
  }
}

class FixtureJobCoordinator implements HostedJobCoordinator {
  readonly schedules = new Map<string, unknown>();
  readonly finished = new Map<string, string>();
  readonly leases = new Map<string, ReturnType<FixtureJobCoordinator["claim"]> & { input: Parameters<HostedJobCoordinator["claim"]>[0] }>();
  readonly scheduleOperations = new Map<string, string>();
  readonly claimOperations = new Map<string, ReturnType<FixtureJobCoordinator["claim"]>>();
  readonly cancelledEnableOperations = new Set<string>();
  readonly cancelledClaimOperations = new Set<string>();
  #nextSchedule = 1;
  #nextLease = 1;
  failDisable = false;
  failFinish = false;
  failCancelClaim = false;
  beforeEnable?: () => void;
  afterEnable?: () => void;
  beforeClaim?: () => void;
  afterClaim?: () => void;
  readonly invalidLeases = new Set<string>();

  enable(input: Parameters<HostedJobCoordinator["enable"]>[0]): string {
    this.beforeEnable?.();
    if (this.cancelledEnableOperations.has(input.operationId)) throw new Error("enable operation was durably cancelled");
    const existing = this.scheduleOperations.get(input.operationId);
    if (existing) return existing;
    const scheduleId = `schedule_${this.#nextSchedule++}`;
    this.schedules.set(scheduleId, structuredClone(input));
    this.scheduleOperations.set(input.operationId, scheduleId);
    this.afterEnable?.();
    return scheduleId;
  }

  cancelEnable(operationId: string): void {
    this.cancelledEnableOperations.add(operationId);
    const scheduleId = this.scheduleOperations.get(operationId);
    if (!scheduleId) return;
    this.disable(scheduleId);
    this.scheduleOperations.delete(operationId);
  }

  disable(scheduleId: string): void {
    if (this.failDisable) throw new Error("injected scheduler cleanup failure");
    this.schedules.delete(scheduleId);
  }

  claim(input: Parameters<HostedJobCoordinator["claim"]>[0]) {
    this.beforeClaim?.();
    if (this.cancelledClaimOperations.has(input.operationId)) throw new Error("claim operation was durably cancelled");
    const existing = this.claimOperations.get(input.operationId);
    if (existing) return existing;
    if (!this.schedules.has(input.scheduleId)) throw new Error("schedule unavailable");
    const ordinal = this.#nextLease++;
    const lease = {
      leaseId: `lease_${ordinal}`,
      scheduleId: input.scheduleId,
      occurrenceId: `occurrence_${ordinal}`,
      runId: `run_${ordinal}`,
      attemptId: `attempt_${ordinal}`,
    };
    this.leases.set(lease.leaseId, { ...lease, input: structuredClone(input) });
    this.claimOperations.set(input.operationId, lease);
    this.afterClaim?.();
    return lease;
  }

  cancelClaim(operationId: string) {
    if (this.failCancelClaim) throw new Error("injected claim cancellation failure");
    this.cancelledClaimOperations.add(operationId);
    const lease = this.claimOperations.get(operationId);
    if (!lease) return undefined;
    this.finished.set(lease.leaseId, "cancelled");
    return lease;
  }

  validate(input: Parameters<HostedJobCoordinator["validate"]>[0]): void {
    const lease = this.leases.get(input.leaseId);
    if (!lease || this.finished.has(input.leaseId) || this.invalidLeases.has(input.leaseId)
      || lease.scheduleId !== input.scheduleId || lease.occurrenceId !== input.occurrenceId
      || lease.runId !== input.runId || lease.attemptId !== input.attemptId
      || lease.input.operationId !== input.operationId
      || lease.input.runtimeInstanceId !== input.runtimeInstanceId
      || lease.input.featureInstallationId !== input.featureInstallationId
      || lease.input.jobId !== input.jobId) throw new Error("lease is stale");
  }

  finish(leaseId: string, state: "succeeded" | "failed" | "cancelled"): void {
    if (this.failFinish) throw new Error("injected lease completion failure");
    this.finished.set(leaseId, state);
  }
}

class FixtureRevocationHighWater implements HostedInstanceRevocationHighWater {
  readonly markers = new Map<string, HostedInstanceRevocationMarker>();
  failNextRaise = false;
  afterRaise?: () => void;

  raise(marker: Readonly<HostedInstanceRevocationMarker>): void {
    if (this.failNextRaise) {
      this.failNextRaise = false;
      throw new Error("injected high-water failure");
    }
    const existing = this.markers.get(marker.runtimeInstanceId);
    if (existing) {
      const existingIdentity = {
        revocationId: existing.revocationId,
        tenantId: existing.tenantId,
        projectId: existing.projectId,
        cloudProjectId: existing.cloudProjectId,
        runtimeInstanceId: existing.runtimeInstanceId,
        tombstonedAt: existing.tombstonedAt,
        effectivePrincipal: existing.effectivePrincipal,
        deleteReceipts: existing.deleteReceipts,
      };
      const markerIdentity = {
        revocationId: marker.revocationId,
        tenantId: marker.tenantId,
        projectId: marker.projectId,
        cloudProjectId: marker.cloudProjectId,
        runtimeInstanceId: marker.runtimeInstanceId,
        tombstonedAt: marker.tombstonedAt,
        effectivePrincipal: marker.effectivePrincipal,
        deleteReceipts: marker.deleteReceipts,
      };
      if (JSON.stringify(existingIdentity) !== JSON.stringify(markerIdentity)
        || (existing.phase === "purged" && JSON.stringify(existing) !== JSON.stringify(marker))) {
        throw new Error("conflicting revocation marker");
      }
    }
    this.markers.set(marker.runtimeInstanceId, structuredClone(marker));
    this.afterRaise?.();
  }

  read(runtimeInstanceId: Parameters<HostedInstanceRevocationHighWater["read"]>[0]): unknown | undefined {
    const marker = this.markers.get(runtimeInstanceId);
    return marker === undefined ? undefined : structuredClone(marker);
  }
}

interface Fixture {
  readonly service: PrivateHostedAppService;
  readonly vault: FixtureVault;
  readonly broker: FixtureBroker;
  readonly projectId: ProjectId;
  readonly cloudProjectId: CloudProjectId;
  readonly tenantId: TenantId;
  readonly otherTenantId: TenantId;
  readonly principalIds: Readonly<{
    projectOwner: PrincipalId;
    reviewer: PrincipalId;
    publisher: PrincipalId;
    owner: PrincipalId;
    admin: PrincipalId;
    member: PrincipalId;
    otherAdmin: PrincipalId;
  }>;
  readonly release: AppReleaseEnvelope;
  readonly repository: FixtureStateRepository;
  readonly coordinator: FixtureJobCoordinator;
  readonly highWater: FixtureRevocationHighWater;
  readonly restartService: () => PrivateHostedAppService;
  readonly advanceClock: (milliseconds: number) => void;
}

test("review, publication, and hosted deployment preserve role separation and default-off powers", async () => {
  const fixture = createFixture();
  const { service, release, tenantId, vault, broker } = fixture;

  assertHostedError(
    () => service.reviewRelease({ authentication: "publisher", release }),
    "RESOURCE_DENIED",
  );
  service.reviewRelease({ authentication: "reviewer", release });
  assertHostedError(
    () => service.deployHostedInstance({ authentication: "admin", tenantId, releaseDigest: release.releaseDigest }),
    "NOT_FOUND",
  );
  service.publishReviewedRelease({ authentication: "publisher", releaseDigest: release.releaseDigest });
  const deployed = service.deployHostedInstance({
    authentication: "admin",
    tenantId,
    releaseDigest: release.releaseDigest,
  });

  assert.equal(deployed.host, "hosted");
  assert.equal(deployed.status, "active");
  assert.deepEqual(deployed.features[0]?.networkGrants, []);
  assert.deepEqual(deployed.features[0]?.connections, []);
  assert.deepEqual(deployed.features[0]?.jobs, [{ jobId: "refresh", enabled: false }]);
  await assert.rejects(
    service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "RESOURCE_DENIED"),
  );

  service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  const secret = encoder.encode("never-return-this-secret");
  const connected = service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret,
  });
  assert.equal(new TextDecoder().decode(secret), "never-return-this-secret", "the caller's buffer is not retained or zeroed");
  assert.equal(vault.values.size, 1);
  assert.equal(connected.features[0]?.connections[0]?.owner.kind, "instance");
  const enabled = service.enableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  assert.equal(enabled.features[0]?.jobs[0]?.enabled, true);

  const completed = await service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.effectivePrincipal.principalId, fixture.principalIds.member);
  assert.equal(completed.releaseDigest, release.releaseDigest);
  assert.equal(completed.featureRevisionDigest, deployed.features[0]?.featureRevisionDigest);
  assert.equal(completed.jobId, "refresh");
  assert.equal(broker.effectCount, 1);

  const exported = service.exportInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  const serialized = JSON.stringify({ connected, enabled, completed, exported });
  assert.doesNotMatch(serialized, /never-return-this-secret/);
  assert.doesNotMatch(serialized, /vault-ref-/);
  assert.equal(exported.completeness.secretsIncluded, false);
  assert.equal(exported.completeness.projectSourceIncluded, false);
  assert.equal(exported.completeness.immutableReleaseIncluded, false);
  const jobReceipts = exported.receipts.filter((receipt) => receipt.kind === "job");
  assert.deepEqual(jobReceipts.map((receipt) => receipt.state), ["accepted", "succeeded"]);
  assert.equal(jobReceipts[1]?.parentReceiptId, jobReceipts[0]?.receiptId);
  assert.ok(jobReceipts.every((receipt) => Object.isFrozen(receipt)));

  assertHostedError(
    () => service.getInstance({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      extra: true,
    } as never),
    "INVALID_INPUT",
  );
  assertHostedError(
    () => service.reviewRelease({ authentication: "reviewer", release }),
    "CONFLICT",
  );
});

test("authenticated Tenant context denies cross-tenant reads, exports, and mutations", () => {
  const fixture = createFixture();
  const deployed = publishAndDeploy(fixture);

  for (const operation of [
    () => fixture.service.getInstance({ authentication: "other-admin", runtimeInstanceId: deployed.runtimeInstanceId }),
    () => fixture.service.exportInstance({ authentication: "other-admin", runtimeInstanceId: deployed.runtimeInstanceId }),
    () => fixture.service.grantNetwork({
      authentication: "other-admin",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      declarationId: "mail-api",
    }),
  ]) {
    assertHostedError(operation, "RESOURCE_DENIED");
  }
  assertHostedError(
    () => fixture.service.getInstance({ authentication: "not-a-session", runtimeInstanceId: deployed.runtimeInstanceId }),
    "AUTHENTICATION_REQUIRED",
  );
});

test("effect-time authorization rejects stale work and records bounded failure lineage", async () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  fixture.broker.beforeAuthorize = () => {
    fixture.service.suspendInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  };

  await assert.rejects(
    fixture.service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => {
      assert.ok(error instanceof HostedAppPlatformError);
      assert.equal(error.code, "AUTHORITY_STALE");
      assert.ok(error.runtimeError.receiptId);
      return true;
    },
  );
  assert.equal(fixture.broker.effectCount, 0);
  const receipts = fixture.service.listReceipts({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  const failed = receipts.find((receipt) => receipt.kind === "job" && receipt.state === "failed");
  assert.equal(failed?.error?.code, "AUTHORITY_STALE");
  assert.equal(failed?.effectivePrincipal.principalId, fixture.principalIds.member);
  assert.equal(JSON.stringify(failed).includes("vault-ref"), false);
});

test("network revocation, suspension, Principal revocation, and deletion fence future effects", async () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  const original = deployed.features[0]!;

  const revoked = fixture.service.revokeNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  assert.deepEqual(revoked.features[0]?.networkGrants, []);
  assert.deepEqual(revoked.features[0]?.connections, []);
  assert.equal(revoked.features[0]?.jobs[0]?.enabled, false);
  assert.notEqual(revoked.features[0]?.authority.grantGeneration, original.authority.grantGeneration);
  assert.notEqual(revoked.features[0]?.authority.connectionGeneration, original.authority.connectionGeneration);
  assert.notEqual(revoked.features[0]?.authority.jobGeneration, original.authority.jobGeneration);
  assert.equal(fixture.vault.values.size, 0);
  assert.equal(fixture.vault.destroyed.length, 1);

  await assert.rejects(
    fixture.service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "RESOURCE_DENIED"),
  );

  const resumed = fixture.service.suspendInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(resumed.status, "suspended");
  await assert.rejects(
    fixture.service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"),
  );
  fixture.service.resumeInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  fixture.service.revokePrincipalAccess({
    authentication: "owner",
    tenantId: fixture.tenantId,
    principalId: fixture.principalIds.member,
  });
  assertHostedError(
    () => fixture.service.getInstance({ authentication: "member", runtimeInstanceId: deployed.runtimeInstanceId }),
    "RESOURCE_DENIED",
  );

  assertHostedError(
    () => fixture.service.deleteInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId }),
    "RESOURCE_DENIED",
  );
  const deleted = fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(deleted.status, "delete-pending");
  const exported = fixture.service.exportInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(exported.instance.status, "delete-pending");
  assert.equal(exported.completeness.secretsIncluded, false);
  assert.equal(exported.receipts.some((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-delete-requested"), true);
});

test("a reviewed release update is stale after authority changes and atomically resets changed Feature powers", () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  const before = deployed.features[0]!;
  const target = createRelease(fixture.projectId, "0.2.0", "revision-two");
  fixture.service.reviewRelease({ authentication: "reviewer", release: target });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: target.releaseDigest });

  const staleReview = fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  });
  fixture.service.suspendInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  const suspendedService = fixture.restartService();
  assertHostedError(
    () => suspendedService.activateReviewedUpdate({ authentication: "admin", updateId: staleReview.updateId }),
    "NOT_FOUND",
  );
  suspendedService.resumeInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  assertHostedError(
    () => fixture.service.activateReviewedUpdate({ authentication: "admin", updateId: staleReview.updateId }),
    "NOT_FOUND",
  );

  const authorityStaleReview = fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  });
  fixture.service.revokeNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  assertHostedError(
    () => fixture.service.activateReviewedUpdate({ authentication: "admin", updateId: authorityStaleReview.updateId }),
    "AUTHORITY_STALE",
  );
  const review = fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  });
  assert.deepEqual(review.decisions, [{
    featureId: "connected-inbox",
    revision: "changed",
    grants: "reset",
    connections: "reset",
    jobs: "reset",
    data: "compatible",
  }]);
  assertHostedError(() => fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  }), "CONFLICT");
  const updated = fixture.service.activateReviewedUpdate({ authentication: "admin", updateId: review.updateId });
  const after = updated.features[0]!;
  assert.equal(updated.releaseDigest, target.releaseDigest);
  assert.equal(after.featureInstallationId, before.featureInstallationId);
  assert.equal(after.dataNamespaceId, before.dataNamespaceId);
  assert.notEqual(after.featureRevisionDigest, before.featureRevisionDigest);
  assert.deepEqual(after.networkGrants, []);
  assert.deepEqual(after.connections, []);
  assert.deepEqual(after.jobs, [{ jobId: "refresh", enabled: false }]);
  assert.notEqual(after.authority.runtimeInstanceGeneration, before.authority.runtimeInstanceGeneration);
  assert.notEqual(after.authority.featureInstallationGeneration, before.authority.featureInstallationGeneration);
  assert.notEqual(after.authority.grantGeneration, before.authority.grantGeneration);
  assert.notEqual(after.authority.connectionGeneration, before.authority.connectionGeneration);
  assert.notEqual(after.authority.jobGeneration, before.authority.jobGeneration);
  assert.equal(after.authority.principalGeneration, before.authority.principalGeneration);
  assert.equal(after.authority.dataGeneration, before.authority.dataGeneration);
  assert.equal(fixture.vault.values.size, 0);
});

test("an unchanged reviewed Feature retains narrowly eligible authority across an atomic Release switch", () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  const before = deployed.features[0]!;
  const target = createRelease(fixture.projectId, "0.1.1", "revision-one");
  fixture.service.reviewRelease({ authentication: "reviewer", release: target });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: target.releaseDigest });
  const review = fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  });
  assert.deepEqual(review.decisions, [{
    featureId: "connected-inbox",
    revision: "unchanged",
    grants: "eligible-to-retain",
    connections: "eligible-to-retain",
    jobs: "eligible-to-retain",
    data: "compatible",
  }]);

  const updated = fixture.service.activateReviewedUpdate({ authentication: "admin", updateId: review.updateId });
  const after = updated.features[0]!;
  assert.deepEqual(after.networkGrants, before.networkGrants);
  assert.deepEqual(after.connections, before.connections);
  assert.deepEqual(after.jobs, before.jobs);
  assert.equal(after.featureInstallationId, before.featureInstallationId);
  assert.equal(after.dataNamespaceId, before.dataNamespaceId);
  assert.notEqual(after.authority.runtimeInstanceGeneration, before.authority.runtimeInstanceGeneration);
  assert.equal(after.authority.featureInstallationGeneration, before.authority.featureInstallationGeneration);
  assert.equal(after.authority.grantGeneration, before.authority.grantGeneration);
  assert.equal(after.authority.connectionGeneration, before.authority.connectionGeneration);
  assert.equal(after.authority.jobGeneration, before.authority.jobGeneration);
  assert.equal(fixture.vault.values.size, 1);
});

test("cloud Project binding is a Project-owner act independent of Tenant administration", () => {
  const fixture = createFixture();
  assertHostedError(
    () => fixture.service.bindCloudProject({
      authentication: "admin",
      projectId: fixture.projectId,
    }),
    "RESOURCE_DENIED",
  );
  const deployed = publishAndDeploy(fixture);
  assert.equal(deployed.cloudProjectId, fixture.cloudProjectId);
  assert.equal(deployed.projectId, fixture.projectId);
  assert.notEqual(deployed.tenantId, deployed.cloudProjectId);
});

test("connection, job, and receipt identities are exact and independently revocable", () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  const connection = deployed.features[0]!.connections[0]!;
  assert.equal(connection.targetIdentity, "https://api.example.com");
  assert.equal(connection.featureRevisionDigest, deployed.features[0]!.featureRevisionDigest);
  assert.equal(connection.declarationDigest, deployed.features[0]!.declarationDigest);
  assert.deepEqual(connection.owner, { kind: "instance", runtimeInstanceId: deployed.runtimeInstanceId });
  const vaultBinding = fixture.vault.bindings.values().next().value;
  assert.equal(vaultBinding?.featureRevisionDigest, connection.featureRevisionDigest);
  assert.equal(vaultBinding?.declarationDigest, connection.declarationDigest);
  assert.equal(vaultBinding?.targetIdentity, connection.targetIdentity);
  assert.deepEqual(vaultBinding?.owner, connection.owner);
  assert.equal(
    vaultBinding?.authority.connectionGeneration,
    deployed.features[0]!.authority.connectionGeneration,
  );

  const disabled = fixture.service.disableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  assert.deepEqual(disabled.features[0]?.jobs, [{ jobId: "refresh", enabled: false }]);
  assert.equal(fixture.coordinator.schedules.size, 0);
  fixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const disconnected = fixture.service.disconnectConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    connectionId: connection.connectionId,
  });
  assert.deepEqual(disconnected.features[0]?.connections, []);
  assert.deepEqual(disconnected.features[0]?.jobs, [{ jobId: "refresh", enabled: false }]);
  assert.equal(fixture.coordinator.schedules.size, 0);
  const receipts = fixture.service.listReceipts({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  const bound = receipts.find((receipt) => receipt.kind === "admin-transition" && receipt.action === "connection-bound");
  assert.equal(bound?.declarationId, "mail-account");
  assert.equal(bound?.connectionId, connection.connectionId);
  const enabled = receipts.find((receipt) => receipt.kind === "admin-transition" && receipt.action === "job-enabled");
  assert.equal(enabled?.jobId, "refresh");
  assert.match(enabled?.scheduleId ?? "", /^schedule_/);
});

test("vault, schedule, and lease identities are never reused across instances or cleanup", async () => {
  const fixture = createFixture();
  const first = deployPoweredInstance(fixture);
  const firstSecretRef = [...fixture.vault.bindings]
    .find(([, binding]) => binding.runtimeInstanceId === first.runtimeInstanceId)![0];
  const firstScheduleId = first.features[0]!.jobs[0]!.scheduleId!;
  const second = fixture.service.deployHostedInstance({
    authentication: "admin",
    tenantId: fixture.tenantId,
    releaseDigest: fixture.release.releaseDigest,
  });
  fixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: second.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  fixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: second.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("second-secret"),
  });
  const secondEnabled = fixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: second.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const secondSecretRef = [...fixture.vault.bindings]
    .find(([, binding]) => binding.runtimeInstanceId === second.runtimeInstanceId)![0];
  const secondScheduleId = secondEnabled.features[0]!.jobs[0]!.scheduleId!;
  assert.notEqual(secondSecretRef, firstSecretRef);
  assert.notEqual(secondScheduleId, firstScheduleId);

  fixture.service.disconnectConnection({
    authentication: "admin",
    runtimeInstanceId: first.runtimeInstanceId,
    featureId: "connected-inbox",
    connectionId: first.features[0]!.connections[0]!.connectionId,
  });
  fixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: first.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("replacement-secret"),
  });
  const firstReenabled = fixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: first.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const replacementSecretRef = [...fixture.vault.bindings]
    .find(([, binding]) => binding.runtimeInstanceId === first.runtimeInstanceId)![0];
  const replacementScheduleId = firstReenabled.features[0]!.jobs[0]!.scheduleId!;
  assert.equal(new Set([firstSecretRef, secondSecretRef, replacementSecretRef]).size, 3);
  assert.equal(new Set([firstScheduleId, secondScheduleId, replacementScheduleId]).size, 3);

  const firstRun = await fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: first.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const secondRun = await fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: second.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  assert.notEqual(firstRun.leaseId, secondRun.leaseId);
});

test("durable state, leases, receipts, and secret-cleanup outbox survive restart and commit faults", async () => {
  const fixture = createFixture();
  const deployed = deployPoweredInstance(fixture);
  await fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const restarted = fixture.restartService();
  assert.equal(restarted.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId }).features[0]?.jobs[0]?.enabled, true);
  assert.equal(restarted.listReceipts({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "job").length, 2);

  fixture.repository.failNextCommit = true;
  await assert.rejects(
    restarted.runNamedJob({
      authentication: "member",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"),
  );
  assert.equal(fixture.broker.effectCount, 1, "no effect occurs before accepted receipt durability");
  assert.equal(fixture.coordinator.claimOperations.size, 1, "a failed durable claim reservation acquires no new lease");

  fixture.vault.failDestroy = true;
  fixture.coordinator.failDisable = true;
  const connectionId = restarted.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .features[0]!.connections[0]!.connectionId;
  restarted.disconnectConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    connectionId,
  });
  assert.equal(fixture.vault.values.size, 1, "failed cleanup remains in the opaque vault");
  fixture.vault.failDestroy = false;
  fixture.coordinator.failDisable = false;
  const afterCleanupRestart = fixture.restartService();
  assert.equal(fixture.vault.values.size, 0, "restart drains the durable cleanup outbox");
  assert.equal(fixture.coordinator.schedules.size, 0, "restart drains durable scheduler cleanup");
  assert.deepEqual(afterCleanupRestart.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .features[0]?.connections, []);
});

test("community garden exercises role-shared plots, private preferences, durable reminders, export, deletion, and purge", () => {
  const fixture = createFixture();
  const release = createCommunityGardenRelease(fixture.projectId);
  fixture.service.reviewRelease({ authentication: "reviewer", release });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: release.releaseDigest });
  const deployed = fixture.service.deployHostedInstance({
    authentication: "admin",
    tenantId: fixture.tenantId,
    releaseDigest: release.releaseDigest,
  });
  fixture.service.assignInstanceRole({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    principalId: fixture.principalIds.member,
    roleId: "gardener",
  });

  const plot = fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "plots",
    action: "create",
    recordId: "plot-a",
    expectedRevision: null,
    value: { crop: "tomatoes", steward: "Sam" },
  });
  const plotReceipt = fixture.service.commitDataMutation({ authentication: "member", mutationId: plot.mutationId });
  assert.equal(plotReceipt.collectionId, "plots");
  assert.equal(fixture.service.listCollection({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "plots",
  })[0]?.value && (fixture.service.listCollection({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "plots",
  })[0]!.value as { crop: string }).crop, "tomatoes");
  assertHostedError(
    () => fixture.service.listCollection({
      authentication: "admin",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "community-garden",
      collectionId: "plots",
    }),
    "RESOURCE_DENIED",
  );

  const pendingUpdate = fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "plots",
    action: "update",
    recordId: "plot-a",
    expectedRevision: 1,
    value: { crop: "beans", steward: "Sam" },
  });
  fixture.service.removeInstanceRole({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    principalId: fixture.principalIds.member,
    roleId: "gardener",
  });
  assertHostedError(
    () => fixture.service.commitDataMutation({ authentication: "member", mutationId: pendingUpdate.mutationId }),
    "AUTHORITY_STALE",
  );

  const preference = fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "contact-preferences",
    action: "create",
    recordId: "reminders",
    expectedRevision: null,
    value: { channel: "email", enabled: true },
  });
  fixture.service.commitDataMutation({ authentication: "member", mutationId: preference.mutationId });
  assert.equal(fixture.service.listCollection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "contact-preferences",
  }).length, 0, "Principal-private partitions cannot be selected by another Principal");
  const principalExport = fixture.service.exportPrincipalData({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
  });
  assert.equal(principalExport.data.find((item) => item.collectionId === "contact-preferences")?.records.length, 1);
  assert.equal(principalExport.secretsIncluded, false);

  const announcement = fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    collectionId: "announcements",
    action: "create",
    recordId: "watering-day",
    expectedRevision: null,
    value: { text: "Water on Friday" },
  });
  fixture.service.commitDataMutation({ authentication: "member", mutationId: announcement.mutationId });
  fixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    declarationId: "reminder-api",
  });
  fixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    declarationId: "reminder-service",
    secret: encoder.encode("garden-reminder-secret"),
  });
  const scheduled = fixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "community-garden",
    jobId: "send-reminders",
  });
  assert.match(scheduled.features[0]?.jobs[0]?.scheduleId ?? "", /^schedule_/);

  const exported = fixture.service.exportInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(JSON.stringify(exported).includes("garden-reminder-secret"), false);
  assert.equal(exported.data.find((item) => item.collectionId === "plots")?.partitions[0]?.records?.length, 1);
  assert.equal(exported.data.find((item) => item.collectionId === "contact-preferences")?.partitions[0]?.omittedPrincipalPrivateRecords, 1);
  assert.equal(exported.completeness.principalPrivateContents, "requester-only");

  const preDeletionBackup = structuredClone(fixture.repository.state);
  const deleting = fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(deleting.status, "delete-pending");
  const tombstone = fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.equal(tombstone.status, "purged");
  const purgedExport = fixture.service.exportInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.ok(purgedExport.data.every((collection) => collection.partitions.length === 0));
  assert.equal(purgedExport.receipts.some((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-purged"), true);
  fixture.repository.state = preDeletionBackup;
  const restoredBackup = fixture.restartService();
  assert.equal(restoredBackup.getInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId }).status, "purged");
  const restoredExport = restoredBackup.exportInstance({ authentication: "owner", runtimeInstanceId: deployed.runtimeInstanceId });
  assert.ok(restoredExport.data.every((collection) => collection.partitions.length === 0), "purge high-water prevents record resurrection from backup");
  assert.equal(restoredExport.receipts.some((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-purged"), true);
});

test("effect execution carries an exact lease-bound idempotent identity and durably completes leases", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  const connection = powered.features[0]!.connections[0]!;
  const vaultBinding = fixture.vault.bindings.values().next().value!;
  fixture.coordinator.failFinish = true;

  const receipt = await fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: powered.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const effect = fixture.broker.inputs.at(-1)!;
  assert.equal(receipt.declarationId, "refresh");
  assert.equal(effect.declarationId, "refresh");
  assert.equal(effect.connectionId, connection.connectionId);
  assert.equal(effect.targetIdentity, "https://api.example.com");
  assert.equal(effect.owner.runtimeInstanceId, powered.runtimeInstanceId);
  assert.equal(effect.authKind, "bearer");
  assert.equal(effect.idempotencyKey.startsWith("job-effect-"), true);
  assert.equal(effect.idempotencyKey.length, 75);
  assert.deepEqual(effect.acceptedAuthority, receipt.authority);
  assert.equal(effect.leaseId, receipt.leaseId);
  assert.equal(effect.occurrenceId, receipt.occurrenceId);
  assert.equal(effect.runId, receipt.runId);
  assert.equal(effect.attemptId, receipt.attemptId);
  assert.equal(effect.claimOperationId, receipt.claimOperationId);
  assert.equal(vaultBinding.connectionId, effect.connectionId);
  assert.equal(vaultBinding.networkDeclarationId, effect.networkDeclarationId);
  assert.equal(vaultBinding.releaseDigest, effect.releaseDigest);
  assert.equal(vaultBinding.cloudProjectId, powered.cloudProjectId);
  assert.equal(fixture.coordinator.finished.has(receipt.leaseId), false);

  fixture.coordinator.failFinish = false;
  const restarted = fixture.restartService();
  assert.equal(fixture.coordinator.finished.get(receipt.leaseId), "succeeded");

  fixture.broker.beforeAuthorize = (input) => fixture.coordinator.invalidLeases.add(input.leaseId);
  await assert.rejects(
    restarted.runNamedJob({
      authentication: "member",
      runtimeInstanceId: powered.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "AUTHORITY_STALE"),
  );
  assert.equal(fixture.broker.effectCount, 1);
});

test("stale CAS after vault or scheduler allocation durably merges idempotent cleanup", () => {
  const fixture = createFixture();
  const deployed = publishAndDeploy(fixture);
  fixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  fixture.vault.failCancelStore = true;
  fixture.vault.afterStore = () => { fixture.repository.staleNextCommit = true; };
  assertHostedError(() => fixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("orphan-candidate"),
  }), "HOST_UNAVAILABLE");
  assert.equal(fixture.vault.values.size, 1, "simulated death leaves only a durably reserved allocation");
  fixture.vault.failCancelStore = false;
  fixture.vault.afterStore = undefined;
  let restarted = fixture.restartService();
  assert.equal(fixture.vault.values.size, 0, "restart cancels the allocation by its precommitted operation id");

  restarted.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("retained-secret"),
  });
  fixture.coordinator.failDisable = true;
  fixture.coordinator.afterEnable = () => { fixture.repository.staleNextCommit = true; };
  assertHostedError(() => restarted.enableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  }), "HOST_UNAVAILABLE");
  assert.equal(fixture.coordinator.schedules.size, 1);
  fixture.coordinator.failDisable = false;
  fixture.coordinator.afterEnable = undefined;
  restarted = fixture.restartService();
  assert.equal(fixture.coordinator.schedules.size, 0, "restart cancels schedule allocation by operation id");
  assert.doesNotThrow(() => restarted.getInstance({ authentication: "member", runtimeInstanceId: deployed.runtimeInstanceId }));
});

test("peer recovery forward-cancels live vault, schedule, and claim reservations", async () => {
  const vaultFixture = createFixture();
  const vaultInstance = publishAndDeploy(vaultFixture);
  vaultFixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: vaultInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  let vaultPeer: PrivateHostedAppService | undefined;
  vaultFixture.vault.beforeStore = () => {
    vaultFixture.vault.beforeStore = undefined;
    vaultPeer = vaultFixture.restartService();
  };
  assertHostedError(() => vaultFixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: vaultInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("must-never-allocate"),
  }), "HOST_UNAVAILABLE");
  assert.ok(vaultPeer);
  assert.equal(vaultFixture.vault.values.size, 0);
  assert.equal(vaultFixture.vault.cancelledStoreOperations.size, 1);
  assert.deepEqual(vaultPeer.getInstance({ authentication: "admin", runtimeInstanceId: vaultInstance.runtimeInstanceId })
    .features[0]!.connections, []);

  const scheduleFixture = createFixture();
  const scheduleInstance = publishAndDeploy(scheduleFixture);
  scheduleFixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: scheduleInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  scheduleFixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: scheduleInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("retained-secret"),
  });
  let schedulePeer: PrivateHostedAppService | undefined;
  scheduleFixture.coordinator.beforeEnable = () => {
    scheduleFixture.coordinator.beforeEnable = undefined;
    schedulePeer = scheduleFixture.restartService();
  };
  assertHostedError(() => scheduleFixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: scheduleInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  }), "HOST_UNAVAILABLE");
  assert.ok(schedulePeer);
  assert.equal(scheduleFixture.coordinator.schedules.size, 0);
  assert.equal(scheduleFixture.coordinator.cancelledEnableOperations.size, 1);
  assert.deepEqual(schedulePeer.getInstance({ authentication: "admin", runtimeInstanceId: scheduleInstance.runtimeInstanceId })
    .features[0]!.jobs, [{ jobId: "refresh", enabled: false }]);

  const claimFixture = createFixture();
  const claimInstance = deployPoweredInstance(claimFixture);
  let claimPeer: PrivateHostedAppService | undefined;
  claimFixture.coordinator.beforeClaim = () => {
    claimFixture.coordinator.beforeClaim = undefined;
    claimPeer = claimFixture.restartService();
  };
  await assert.rejects(claimFixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: claimInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  }), (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"));
  assert.ok(claimPeer);
  assert.equal(claimFixture.coordinator.leases.size, 0);
  assert.equal(claimFixture.coordinator.cancelledClaimOperations.size, 1);
  assert.equal(claimPeer.listReceipts({ authentication: "admin", runtimeInstanceId: claimInstance.runtimeInstanceId })
    .some((receipt) => receipt.kind === "job"), false);
});

test("a precommitted deletion reservation fences a job paused before its external effect", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  fixture.broker.beforeAuthorize = () => {
    fixture.broker.beforeAuthorize = undefined;
    fixture.highWater.failNextRaise = true;
    assertHostedError(
      () => fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }),
      "HOST_UNAVAILABLE",
    );
  };
  await assert.rejects(fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: powered.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  }), (error: unknown) => isHostedError(error, "AUTHORITY_STALE"));
  assert.equal(fixture.broker.effectCount, 0);
  const recovered = fixture.restartService();
  assert.equal(recovered.getInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }).status, "delete-pending");
});

test("restart reconciles a claimed attempt that died before its accepted receipt commit", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  fixture.coordinator.failCancelClaim = true;
  fixture.coordinator.afterClaim = () => { fixture.repository.staleNextCommit = true; };
  await assert.rejects(
    fixture.service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: powered.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"),
  );
  assert.equal(fixture.broker.effectCount, 0);
  fixture.coordinator.failCancelClaim = false;
  fixture.coordinator.afterClaim = undefined;
  const restarted = fixture.restartService();
  const receipts = restarted.listReceipts({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "job");
  assert.deepEqual(receipts.map((receipt) => receipt.state), ["accepted", "cancelled"]);
  assert.equal(receipts[1]!.parentReceiptId, receipts[0]!.receiptId);
  assert.equal((receipts[0] as any).claimOperationId, (receipts[1] as any).claimOperationId);
  assert.equal(fixture.coordinator.finished.get((receipts[0] as any).leaseId), "cancelled");
});

test("restart terminalizes an accepted attempt whose post-effect outcome was not durably recorded", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  fixture.broker.afterEffect = () => { fixture.repository.staleNextCommit = true; };
  await assert.rejects(
    fixture.service.runNamedJob({
      authentication: "member",
      runtimeInstanceId: powered.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"),
  );
  assert.equal(fixture.broker.effectCount, 1);
  fixture.broker.afterEffect = undefined;
  const restarted = fixture.restartService();
  const receipts = restarted.listReceipts({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "job");
  assert.deepEqual(receipts.map((receipt) => receipt.state), ["accepted", "cancelled"]);
  assert.equal(receipts[1]!.error?.code, "HOST_UNAVAILABLE");
  assert.match(receipts[1]!.error?.message ?? "", /outcome is unknown/);
  assert.equal(fixture.broker.effectCount, 1, "recovery never guesses by replaying an effect with unknown outcome");
});

test("purge waits for every accepted job lease to gain terminal receipt lineage", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  fixture.broker.afterEffect = () => { fixture.repository.staleNextCommit = true; };
  await assert.rejects(fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: powered.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  }), (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"));
  fixture.broker.afterEffect = undefined;
  fixture.coordinator.failCancelClaim = true;
  fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assertHostedError(
    () => fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );

  fixture.coordinator.failCancelClaim = false;
  const purged = fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assert.equal(purged.status, "purged");
  const jobs = fixture.service.listReceipts({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "job");
  assert.deepEqual(jobs.map((receipt) => receipt.state), ["accepted", "cancelled"]);
  assert.equal(jobs[1]!.parentReceiptId, jobs[0]!.receiptId);
  assert.equal(fixture.coordinator.finished.get(jobs[0]!.leaseId), "cancelled");
});

test("purge waits for structured instance cleanup and high-water fencing defeats backup resurrection", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  const preDeletionBackup = structuredClone(fixture.repository.state);
  fixture.vault.failDestroy = true;
  fixture.coordinator.failDisable = true;
  fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assert.equal(fixture.highWater.markers.has(powered.runtimeInstanceId), true);
  const marker = fixture.highWater.markers.get(powered.runtimeInstanceId)!;
  fixture.highWater.markers.set(powered.runtimeInstanceId, { ...marker, tenantId: fixture.otherTenantId });
  assert.throws(
    () => fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE") && /high-water/.test((error as Error).message),
    "purge fails closed when the high-water identity conflicts",
  );
  fixture.highWater.markers.set(powered.runtimeInstanceId, marker);
  assertHostedError(
    () => fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );

  fixture.vault.failDestroy = false;
  fixture.coordinator.failDisable = false;
  const purged = fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assert.equal(purged.status, "purged");

  fixture.repository.state = preDeletionBackup;
  fixture.vault.failDestroy = true;
  fixture.coordinator.failDisable = true;
  const resurrectedBackup = fixture.restartService();
  assert.equal(resurrectedBackup.getInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }).status, "purged");
  const restoredExport = resurrectedBackup.exportInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId });
  assert.equal(restoredExport.instance.status, "purged");
  assert.ok(restoredExport.data.every((collection) => collection.partitions.length === 0));
  assertHostedError(
    () => resurrectedBackup.suspendInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }),
    "CONFLICT",
  );
  assertHostedError(
    () => resurrectedBackup.resumeInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }),
    "CONFLICT",
  );
  await assert.rejects(
    resurrectedBackup.runNamedJob({
      authentication: "member",
      runtimeInstanceId: powered.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "HOST_UNAVAILABLE"),
  );
  assert.equal(fixture.broker.effectCount, 0);
  const failedCleanupState = decodeHostedStateValue((fixture.repository.state as { payload: unknown }).payload);
  assert.equal(failedCleanupState.pendingSecretCleanup.size, 1);
  assert.equal(failedCleanupState.pendingScheduleCleanup.size, 1);
  const repeatedFailure = fixture.restartService();
  assert.equal(repeatedFailure.getInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }).status, "purged");
  fixture.vault.failDestroy = false;
  fixture.coordinator.failDisable = false;
  fixture.restartService();
  const drainedCleanupState = decodeHostedStateValue((fixture.repository.state as { payload: unknown }).payload);
  assert.equal(drainedCleanupState.pendingSecretCleanup.size, 0);
  assert.equal(drainedCleanupState.pendingScheduleCleanup.size, 0);
});

test("startup reconciles a high-water tombstone after process death before deletion commit", () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  const target = createRelease(fixture.projectId, "0.2.0", "delete-review-cleanup");
  fixture.service.reviewRelease({ authentication: "reviewer", release: target });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: target.releaseDigest });
  fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: powered.runtimeInstanceId,
    toReleaseDigest: target.releaseDigest,
  });
  fixture.vault.failDestroy = true;
  fixture.coordinator.failDisable = true;
  fixture.highWater.afterRaise = () => {
    fixture.highWater.afterRaise = undefined;
    fixture.repository.staleNextCommit = true;
  };
  assertHostedError(
    () => fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );
  assert.equal(fixture.highWater.markers.has(powered.runtimeInstanceId), true);

  const recovered = fixture.restartService();
  const recoveredView = recovered.getInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId });
  assert.equal(recoveredView.status, "delete-pending");
  assert.deepEqual(recoveredView.features[0]!.networkGrants, []);
  assert.deepEqual(recoveredView.features[0]!.connections, []);
  assert.deepEqual(recoveredView.features[0]!.jobs, [{ jobId: "refresh", enabled: false }]);
  assert.equal(recovered.listReceipts({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId })
    .some((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-delete-requested"), true);
  assert.equal(recovered.exportInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }).instance.status, "delete-pending");
  assertHostedError(
    () => recovered.suspendInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }),
    "CONFLICT",
  );
  assertHostedError(
    () => recovered.resumeInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }),
    "CONFLICT",
  );
  assert.equal(fixture.vault.values.size, 1, "failed cleanup remains durably queued");
  assert.equal(fixture.coordinator.schedules.size, 1, "failed schedule cleanup remains durably queued");

  fixture.vault.failDestroy = false;
  fixture.coordinator.failDisable = false;
  const drained = fixture.restartService();
  assert.equal(fixture.vault.values.size, 0);
  assert.equal(fixture.coordinator.schedules.size, 0);
  assert.equal(drained.getInstance({ authentication: "admin", runtimeInstanceId: powered.runtimeInstanceId }).status, "delete-pending");
});

test("a byte-heavy live backup reserves enough room to reconcile a later deletion tombstone", () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  padStateNearDurableLimit(fixture.repository, fixture.principalIds.member, 0);
  const heavyBackup = structuredClone(fixture.repository.state);
  const shrunken = structuredClone(fixture.repository.state) as { revision: number; payload: unknown };
  const payload = decodeHostedStateValue(shrunken.payload);
  payload.instances.values().next().value.installations.values().next().value.dataCollections.get("messages").partitions.clear();
  shrunken.payload = encodeHostedStateValue(payload);
  shrunken.revision += 1;
  fixture.repository.state = shrunken;
  fixture.restartService().deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });

  fixture.repository.state = heavyBackup;
  const restored = fixture.restartService();
  assert.equal(restored.getInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }).status, "delete-pending");
  assert.equal(restored.listReceipts({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId })
    .some((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-delete-requested"), true);
  assert.equal(fixture.restartService().getInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }).status, "delete-pending");
});

test("a purged high-water dominates a restored pending-delete reservation snapshot", () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  const mutation = fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: powered.runtimeInstanceId,
    featureId: "connected-inbox",
    collectionId: "messages",
    action: "create",
    recordId: "must-stay-purged",
    expectedRevision: null,
    value: { body: "never resurrect" },
  });
  fixture.service.commitDataMutation({ authentication: "member", mutationId: mutation.mutationId });
  let pendingDeleteBackup: unknown;
  fixture.highWater.afterRaise = () => {
    fixture.highWater.afterRaise = undefined;
    pendingDeleteBackup = structuredClone(fixture.repository.state);
  };
  fixture.service.deleteInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assert.ok(pendingDeleteBackup);
  fixture.service.purgeInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });

  fixture.repository.state = pendingDeleteBackup;
  const restored = fixture.restartService();
  assert.equal(restored.getInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }).status, "purged");
  const exported = restored.exportInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId });
  assert.ok(exported.data.every((collection) => collection.partitions.length === 0));
  assert.equal(fixture.restartService().getInstance({ authentication: "owner", runtimeInstanceId: powered.runtimeInstanceId }).status, "purged");
});

test("high-water reconciliation validates every instance before mutating the shared snapshot", () => {
  const fixture = createFixture();
  const first = publishAndDeploy(fixture);
  const second = fixture.service.deployHostedInstance({
    authentication: "admin",
    tenantId: fixture.tenantId,
    releaseDigest: fixture.release.releaseDigest,
  });
  const timestamp = "2026-07-15T12:30:00.000Z";
  const firstMarker: HostedInstanceRevocationMarker = {
    revocationId: `revocation_${"1".repeat(36)}`,
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    cloudProjectId: fixture.cloudProjectId,
    runtimeInstanceId: first.runtimeInstanceId,
    tombstonedAt: timestamp,
    effectivePrincipal: principal(fixture.principalIds.owner),
    deleteReceipts: [{
      featureInstallationId: first.features[0]!.featureInstallationId,
      receiptId: `receipt_${"1".repeat(36)}`,
    }],
    phase: "delete-pending",
  };
  const invalidLaterMarker: HostedInstanceRevocationMarker = {
    ...firstMarker,
    revocationId: `revocation_${"2".repeat(36)}`,
    tenantId: fixture.otherTenantId,
    runtimeInstanceId: second.runtimeInstanceId,
    deleteReceipts: [{
      featureInstallationId: second.features[0]!.featureInstallationId,
      receiptId: `receipt_${"2".repeat(36)}`,
    }],
  };
  fixture.highWater.markers.set(first.runtimeInstanceId, firstMarker);
  fixture.highWater.markers.set(second.runtimeInstanceId, invalidLaterMarker);
  assertHostedError(
    () => fixture.service.getInstance({ authentication: "admin", runtimeInstanceId: first.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );
  fixture.highWater.markers.delete(second.runtimeInstanceId);
  assert.equal(fixture.service.getInstance({ authentication: "admin", runtimeInstanceId: first.runtimeInstanceId }).status, "delete-pending");
  const persisted = decodeHostedStateValue((fixture.repository.state as { payload: unknown }).payload);
  assert.equal(persisted.instances.get(first.runtimeInstanceId).status, "delete-pending");
});

test("pending mutation TTL and per-Principal quotas fail with stable runtime errors", () => {
  const fixture = createFixture();
  const deployed = publishAndDeploy(fixture);
  const mutations = Array.from({ length: 32 }, (_, index) => fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    collectionId: "preferences",
    action: "create",
    recordId: `preference-${index}`,
    expectedRevision: null,
    value: { index },
  }));
  assertHostedError(() => fixture.service.prepareDataMutation({
    authentication: "member",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    collectionId: "preferences",
    action: "create",
    recordId: "preference-overflow",
    expectedRevision: null,
    value: { overflow: true },
  }), "QUOTA_EXCEEDED");
  fixture.advanceClock(15 * 60 * 1_000);
  assertHostedError(
    () => fixture.service.commitDataMutation({ authentication: "member", mutationId: mutations[0]!.mutationId }),
    "AUTHORITY_EXPIRED",
  );
});

test("receipt quota preflight leaves authority unchanged and performs no external allocation", () => {
  const grantFixture = createFixture();
  const grantInstance = publishAndDeploy(grantFixture);
  saturateInstanceReceipts(grantFixture.repository, grantInstance.runtimeInstanceId);
  const grantService = grantFixture.restartService();
  assertHostedError(() => grantService.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: grantInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  }), "QUOTA_EXCEEDED");
  assert.deepEqual(grantService.getInstance({ authentication: "admin", runtimeInstanceId: grantInstance.runtimeInstanceId })
    .features[0]!.networkGrants, []);

  const allocationFixture = createFixture();
  const allocationInstance = publishAndDeploy(allocationFixture);
  allocationFixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: allocationInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  saturateInstanceReceipts(allocationFixture.repository, allocationInstance.runtimeInstanceId);
  const allocationService = allocationFixture.restartService();
  assertHostedError(() => allocationService.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: allocationInstance.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("must-not-be-allocated"),
  }), "QUOTA_EXCEEDED");
  assert.equal(allocationFixture.vault.values.size, 0);
  assert.deepEqual(allocationService.getInstance({ authentication: "admin", runtimeInstanceId: allocationInstance.runtimeInstanceId })
    .features[0]!.connections, []);
});

test("delete and purge reservations hold their last receipt slot across a peer high-water race", () => {
  const deleteFixture = createFixture();
  const deleteInstance = deployPoweredInstance(deleteFixture);
  saturateInstanceReceipts(deleteFixture.repository, deleteInstance.runtimeInstanceId, 9_998);
  const deleteService = deleteFixture.restartService();
  let deletePeerError: unknown;
  deleteFixture.highWater.afterRaise = () => {
    deleteFixture.highWater.afterRaise = undefined;
    const peer = deleteFixture.restartService();
    try {
      peer.exportInstance({ authentication: "admin", runtimeInstanceId: deleteInstance.runtimeInstanceId });
    } catch (error) {
      deletePeerError = error;
    }
  };
  assertHostedError(
    () => deleteService.deleteInstance({ authentication: "owner", runtimeInstanceId: deleteInstance.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );
  assert.equal(isHostedError(deletePeerError, "QUOTA_EXCEEDED"), true);
  const deleted = deleteFixture.restartService();
  assert.equal(deleted.getInstance({ authentication: "admin", runtimeInstanceId: deleteInstance.runtimeInstanceId }).status, "delete-pending");
  assert.equal(deleted.listReceipts({ authentication: "admin", runtimeInstanceId: deleteInstance.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-delete-requested").length, 1);

  const purgeFixture = createFixture();
  const purgeInstance = deployPoweredInstance(purgeFixture);
  saturateInstanceReceipts(purgeFixture.repository, purgeInstance.runtimeInstanceId, 9_998);
  const purgeService = purgeFixture.restartService();
  purgeService.deleteInstance({ authentication: "owner", runtimeInstanceId: purgeInstance.runtimeInstanceId });
  let purgePeerError: unknown;
  purgeFixture.highWater.afterRaise = () => {
    purgeFixture.highWater.afterRaise = undefined;
    const peer = purgeFixture.restartService();
    try {
      peer.exportInstance({ authentication: "admin", runtimeInstanceId: purgeInstance.runtimeInstanceId });
    } catch (error) {
      purgePeerError = error;
    }
  };
  assertHostedError(
    () => purgeService.purgeInstance({ authentication: "owner", runtimeInstanceId: purgeInstance.runtimeInstanceId }),
    "HOST_UNAVAILABLE",
  );
  assert.equal(isHostedError(purgePeerError, "QUOTA_EXCEEDED"), true);
  const purged = purgeFixture.restartService();
  assert.equal(purged.getInstance({ authentication: "admin", runtimeInstanceId: purgeInstance.runtimeInstanceId }).status, "purged");
  assert.equal(purged.listReceipts({ authentication: "admin", runtimeInstanceId: purgeInstance.runtimeInstanceId })
    .filter((receipt) => receipt.kind === "admin-transition" && receipt.action === "instance-purged").length, 1);
});

test("durable byte headroom is reserved before a claim so recovery cannot brick state", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  padStateNearDurableLimit(fixture.repository, fixture.principalIds.member);
  const restarted = fixture.restartService();
  await assert.rejects(
    restarted.runNamedJob({
      authentication: "member",
      runtimeInstanceId: powered.runtimeInstanceId,
      featureId: "connected-inbox",
      jobId: "refresh",
    }),
    (error: unknown) => isHostedError(error, "QUOTA_EXCEEDED"),
  );
  assert.equal(fixture.coordinator.claimOperations.size, 0);
  assert.equal(fixture.broker.effectCount, 0);
  assert.doesNotThrow(() => fixture.restartService(), "failed admission leaves a restartable durable snapshot");

  const deleteFixture = createFixture();
  const deleteInstance = deployPoweredInstance(deleteFixture);
  padStateNearDurableLimit(deleteFixture.repository, deleteFixture.principalIds.member, 64);
  const deleteService = deleteFixture.restartService();
  assert.equal(deleteService.deleteInstance({ authentication: "owner", runtimeInstanceId: deleteInstance.runtimeInstanceId }).status, "delete-pending");
  assert.equal(deleteFixture.highWater.markers.has(deleteInstance.runtimeInstanceId), true);
  assert.equal(deleteFixture.restartService().getInstance({ authentication: "admin", runtimeInstanceId: deleteInstance.runtimeInstanceId }).status, "delete-pending");
});

test("two services refresh shared CAS state before reads, authorization, and retry", () => {
  const fixture = createFixture();
  const deployed = publishAndDeploy(fixture);
  const peer = fixture.restartService();
  fixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  assert.equal(peer.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .features[0]!.networkGrants.length, 1);
  assert.doesNotThrow(() => peer.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("peer-secret"),
  }));
  assert.equal(fixture.service.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .features[0]!.connections.length, 1);
  fixture.service.revokePrincipalAccess({
    authentication: "owner",
    tenantId: fixture.tenantId,
    principalId: fixture.principalIds.member,
  });
  assertHostedError(
    () => peer.getInstance({ authentication: "member", runtimeInstanceId: deployed.runtimeInstanceId }),
    "RESOURCE_DENIED",
  );
});

test("instance export projects one exact committed revision across a peer CAS", () => {
  const fixture = createFixture();
  const deployed = publishAndDeploy(fixture);
  const peer = fixture.restartService();
  fixture.repository.afterNextCommit = () => {
    peer.grantNetwork({
      authentication: "admin",
      runtimeInstanceId: deployed.runtimeInstanceId,
      featureId: "connected-inbox",
      declarationId: "mail-api",
    });
  };

  const exported = fixture.service.exportInstance({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
  });
  assert.deepEqual(exported.instance.features[0]!.networkGrants, []);
  assert.equal(exported.receipts.some((receipt) => receipt.kind === "admin-transition"
    && receipt.action === "instance-exported"), true);
  assert.equal(exported.receipts.some((receipt) => receipt.kind === "admin-transition"
    && receipt.action === "network-granted"), false, "peer receipt from a later revision cannot leak into the export");

  const current = fixture.restartService();
  assert.equal(current.getInstance({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .features[0]!.networkGrants.length, 1);
  assert.equal(current.listReceipts({ authentication: "admin", runtimeInstanceId: deployed.runtimeInstanceId })
    .some((receipt) => receipt.kind === "admin-transition" && receipt.action === "network-granted"), true);
});

test("strict durable parsing rejects corrupted projections, authority surfaces, lineage, and record abuse", async () => {
  const fixture = createFixture();
  const powered = deployPoweredInstance(fixture);
  await fixture.service.runNamedJob({
    authentication: "member",
    runtimeInstanceId: powered.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
  const nextRelease = createRelease(fixture.projectId, "0.2.0", "strict-parser-next");
  fixture.service.reviewRelease({ authentication: "reviewer", release: nextRelease });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: nextRelease.releaseDigest });
  fixture.service.reviewReleaseUpdate({
    authentication: "admin",
    runtimeInstanceId: powered.runtimeInstanceId,
    toReleaseDigest: nextRelease.releaseDigest,
  });
  const goodState = structuredClone(fixture.repository.state) as { payload: unknown };

  const corruptions: readonly Readonly<{ label: string; mutate: (payload: any) => void }>[] = [
    {
      label: "verified declaration projection",
      mutate: (payload) => { payload.registry.values().next().value.declarations.values().next().value.networkDestinations[0].origin = "https://evil.example"; },
    },
    {
      label: "connection target identity",
      mutate: (payload) => { payload.instances.values().next().value.installations.values().next().value.connections.values().next().value.targetIdentity = "https://evil.example"; },
    },
    {
      label: "duplicate connection declaration binding",
      mutate: (payload) => {
        const connections = payload.instances.values().next().value.installations.values().next().value.connections;
        const duplicate = structuredClone(connections.values().next().value);
        duplicate.connectionId = "connection_duplicate";
        duplicate.secretRef = "vault-ref-duplicate";
        connections.set(duplicate.connectionId, duplicate);
      },
    },
    {
      label: "job schedule invariant",
      mutate: (payload) => { delete payload.instances.values().next().value.installations.values().next().value.jobs.values().next().value.scheduleId; },
    },
    {
      label: "status invariant",
      mutate: (payload) => { payload.instances.values().next().value.status = "purged"; },
    },
    {
      label: "update review decision",
      mutate: (payload) => { payload.updateReviews.values().next().value.decisions[0].revision = "unchanged"; },
    },
    {
      label: "duplicate instance update review",
      mutate: (payload) => {
        const duplicate = structuredClone(payload.updateReviews.values().next().value);
        duplicate.updateId = `update_${"1".repeat(36)}`;
        payload.updateReviews.set(duplicate.updateId, duplicate);
      },
    },
    {
      label: "receipt lineage",
      mutate: (payload) => { payload.runtimeReceipts.find((receipt: any) => receipt.state === "succeeded").parentReceiptId = `receipt_${"0".repeat(36)}`; },
    },
    {
      label: "partition record quota",
      mutate: (payload) => {
        const collection = payload.instances.values().next().value.installations.values().next().value.dataCollections.get("messages");
        const records = new Map();
        for (let index = 0; index < 513; index += 1) records.set(`record-${index}`, {
          recordId: `record-${index}`,
          revision: 1,
          value: { index },
          updatedAt: "2026-07-15T12:00:00.000Z",
          updatedBy: fixture.principalIds.member,
        });
        collection.partitions.set("instance", records);
      },
    },
  ];
  for (const corruption of corruptions) {
    const snapshot = structuredClone(goodState) as { payload: unknown };
    const payload = decodeHostedStateValue(snapshot.payload);
    corruption.mutate(payload);
    snapshot.payload = encodeHostedStateValue(payload);
    fixture.repository.state = snapshot;
    assert.throws(() => fixture.restartService(), (error: unknown) => isHostedError(error, "INVALID_INPUT"), corruption.label);
  }

  fixture.repository.state = {
    recordVersion: 1,
    revision: 1,
    payload: "x".repeat(16 * 1024 * 1024),
  };
  assert.throws(() => fixture.restartService(), (error: unknown) => isHostedError(error, "INVALID_INPUT"), "state byte limit");
});

function createFixture(): Fixture {
  const projectId = createProjectId();
  const cloudProjectId = createCloudProjectId();
  const tenantId = createTenantId();
  const otherTenantId = createTenantId();
  const principalIds = {
    projectOwner: createPrincipalId(),
    reviewer: createPrincipalId(),
    publisher: createPrincipalId(),
    owner: createPrincipalId(),
    admin: createPrincipalId(),
    member: createPrincipalId(),
    otherAdmin: createPrincipalId(),
  } as const;
  const principals = new Map<string, EffectivePrincipal>([
    ["project-owner", principal(principalIds.projectOwner)],
    ["reviewer", principal(principalIds.reviewer)],
    ["publisher", principal(principalIds.publisher)],
    ["owner", principal(principalIds.owner)],
    ["admin", principal(principalIds.admin)],
    ["member", principal(principalIds.member)],
    ["other-admin", principal(principalIds.otherAdmin)],
  ]);
  const vault = new FixtureVault();
  const broker = new FixtureBroker();
  const repository = new FixtureStateRepository();
  const coordinator = new FixtureJobCoordinator();
  const highWater = new FixtureRevocationHighWater();
  let clock = Date.parse("2026-07-15T12:00:00.000Z");
  const options = {
    authenticator: new FixtureAuthenticator(principals),
    cloudProjectRegistry: new FixtureCloudProjectRegistry(new Map([[projectId, cloudProjectId]])),
    secretVault: vault,
    effectBroker: broker,
    stateRepository: repository,
    jobCoordinator: coordinator,
    revocationHighWater: highWater,
    now: () => new Date(clock++),
    projectRoles: [
      { projectId, principalId: principalIds.projectOwner, roles: ["owner"] },
      { projectId, principalId: principalIds.reviewer, roles: ["reviewer"] },
      { projectId, principalId: principalIds.publisher, roles: ["publisher"] },
    ],
    tenantRoles: [
      { tenantId, principalId: principalIds.owner, roles: ["owner"] },
      { tenantId, principalId: principalIds.admin, roles: ["admin"] },
      { tenantId, principalId: principalIds.member, roles: ["member"] },
      { tenantId: otherTenantId, principalId: principalIds.otherAdmin, roles: ["admin"] },
    ],
  } as const;
  const restartService = () => new PrivateHostedAppService(options);
  const service = restartService();
  service.bindCloudProject({ authentication: "project-owner", projectId });
  return {
    service,
    vault,
    broker,
    projectId,
    cloudProjectId,
    tenantId,
    otherTenantId,
    principalIds,
    repository,
    coordinator,
    highWater,
    restartService,
    advanceClock: (milliseconds) => { clock += milliseconds; },
    release: createRelease(projectId, "0.1.0", "revision-one"),
  };
}

function publishAndDeploy(fixture: Fixture) {
  fixture.service.reviewRelease({ authentication: "reviewer", release: fixture.release });
  fixture.service.publishReviewedRelease({ authentication: "publisher", releaseDigest: fixture.release.releaseDigest });
  return fixture.service.deployHostedInstance({
    authentication: "admin",
    tenantId: fixture.tenantId,
    releaseDigest: fixture.release.releaseDigest,
  });
}

function deployPoweredInstance(fixture: Fixture) {
  const deployed = publishAndDeploy(fixture);
  fixture.service.grantNetwork({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-api",
  });
  fixture.service.bindInstanceConnection({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    declarationId: "mail-account",
    secret: encoder.encode("fixture-secret"),
  });
  return fixture.service.enableJob({
    authentication: "admin",
    runtimeInstanceId: deployed.runtimeInstanceId,
    featureId: "connected-inbox",
    jobId: "refresh",
  });
}

function createRelease(projectId: ProjectId, displayVersion: string, revision: string): AppReleaseEnvelope {
  return assembleAppRelease({
    projectId,
    presentation: {
      title: "Connected Inbox",
      description: "A private hosted inbox fixture.",
      icon: "inbox",
    },
    displayVersion,
    runtimeApi: { name: "work-fold.feature-broker", compatibleRange: "1.x" },
    features: [{
      featureId: "connected-inbox",
      featureRevision: {
        mediaType: "application/vnd.work-fold.feature+bundle",
        entries: [{ path: "index.js", bytes: encoder.encode(`export const revision = ${JSON.stringify(revision)};`) }],
      },
      declaration: {
        mediaType: "application/vnd.work-fold.feature-declaration+json",
        value: {
          format: "work-fold.feature-declaration",
          formatVersion: 1,
          networkDestinations: [{ declarationId: "mail-api", origin: "https://api.example.com" }],
          connections: [{ declarationId: "mail-account", networkDeclarationId: "mail-api", authKind: "bearer" }],
          jobs: [{
            jobId: "refresh",
            networkDeclarationId: "mail-api",
            connectionDeclarationId: "mail-account",
            schedule: { kind: "interval", everySeconds: 300 },
          }],
          collections: [
            { collectionId: "messages", ownerClass: "instance", allowedActions: ["create", "list", "read", "update"], allowedRoles: [] },
            { collectionId: "preferences", ownerClass: "principal", allowedActions: ["create", "list", "read", "update"], allowedRoles: [] },
          ],
        },
      },
      dataSchema: {
        schemaId: "connected-inbox-data",
        version: 1,
        definition: {
          mediaType: "application/schema+json",
          value: { title: "Connected inbox data", type: "object", version: 1 },
        },
      },
      migrations: [],
    }],
    dependencyInventory: {
      mediaType: "application/vnd.work-fold.dependencies+json",
      value: { kind: "dependency-inventory", packages: [] },
    },
    buildProvenance: {
      mediaType: "application/vnd.work-fold.provenance+json",
      value: { kind: "build-provenance", builder: "fixture", revision },
    },
    inspectionEvidence: {
      mediaType: "application/vnd.work-fold.inspection+json",
      value: { kind: "inspection-evidence", policy: "fixture-1", decision: "pass" },
    },
    createdAt: "2026-07-15T11:00:00.000Z",
  });
}

function createCommunityGardenRelease(projectId: ProjectId): AppReleaseEnvelope {
  return assembleAppRelease({
    projectId,
    presentation: {
      title: "Community Garden",
      description: "A shared garden fixture.",
      icon: "sprout",
    },
    displayVersion: "1.0.0",
    runtimeApi: { name: "work-fold.feature-broker", compatibleRange: "1.x" },
    features: [{
      featureId: "community-garden",
      featureRevision: {
        mediaType: "application/vnd.work-fold.feature+bundle",
        entries: [{ path: "garden.js", bytes: encoder.encode("export const app = 'community-garden';") }],
      },
      declaration: {
        mediaType: "application/vnd.work-fold.feature-declaration+json",
        value: {
          format: "work-fold.feature-declaration",
          formatVersion: 1,
          networkDestinations: [{ declarationId: "reminder-api", origin: "https://reminders.example.com" }],
          connections: [{ declarationId: "reminder-service", networkDeclarationId: "reminder-api", authKind: "api-key" }],
          jobs: [{
            jobId: "send-reminders",
            networkDeclarationId: "reminder-api",
            connectionDeclarationId: "reminder-service",
            schedule: { kind: "interval", everySeconds: 3600 },
          }],
          collections: [
            { collectionId: "announcements", ownerClass: "instance", allowedActions: ["create", "list", "read", "update"], allowedRoles: [] },
            { collectionId: "contact-preferences", ownerClass: "principal", allowedActions: ["create", "list", "read", "update"], allowedRoles: [] },
            { collectionId: "plots", ownerClass: "role", allowedActions: ["create", "list", "read", "update"], allowedRoles: ["coordinator", "gardener"] },
          ],
        },
      },
      dataSchema: {
        schemaId: "community-garden-data",
        version: 1,
        definition: {
          mediaType: "application/schema+json",
          value: { title: "Community garden data", type: "object", version: 1 },
        },
      },
      migrations: [],
    }],
    dependencyInventory: {
      mediaType: "application/vnd.work-fold.dependencies+json",
      value: { kind: "garden-dependency-inventory", packages: [] },
    },
    buildProvenance: {
      mediaType: "application/vnd.work-fold.provenance+json",
      value: { kind: "garden-build-provenance", builder: "fixture" },
    },
    inspectionEvidence: {
      mediaType: "application/vnd.work-fold.inspection+json",
      value: { kind: "garden-inspection-evidence", policy: "fixture-1", decision: "pass" },
    },
    createdAt: "2026-07-15T11:30:00.000Z",
  });
}

function decodeHostedStateValue(value: any): any {
  if (Array.isArray(value)) return value.map(decodeHostedStateValue);
  if (!value || typeof value !== "object") return value;
  if (value.$hostedType === "map") {
    return new Map(value.entries.map(([key, item]: [unknown, unknown]) => [decodeHostedStateValue(key), decodeHostedStateValue(item)]));
  }
  if (value.$hostedType === "set") return new Set(value.values.map(decodeHostedStateValue));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeHostedStateValue(item)]));
}

function saturateInstanceReceipts(repository: FixtureStateRepository, runtimeInstanceId: string, targetCount = 9_998): void {
  const snapshot = structuredClone(repository.state) as { payload: unknown };
  const payload = decodeHostedStateValue(snapshot.payload);
  const all = [...payload.managementReceipts, ...payload.runtimeReceipts, ...payload.dataReceipts];
  const current = all.filter((receipt: any) => receipt.runtimeInstanceId === runtimeInstanceId).length;
  const template = payload.managementReceipts.find((receipt: any) => receipt.runtimeInstanceId === runtimeInstanceId);
  assert.ok(template);
  for (let index = current; index < targetCount; index += 1) {
    payload.managementReceipts.push({
      ...structuredClone(template),
      receiptId: `receipt_${(index + 1).toString(16).padStart(36, "0")}`,
    });
  }
  snapshot.payload = encodeHostedStateValue(payload);
  repository.state = snapshot;
}

function padStateNearDurableLimit(repository: FixtureStateRepository, updatedBy: PrincipalId, headroom = 4 * 1024): void {
  const snapshot = structuredClone(repository.state) as { payload: unknown };
  const payload = decodeHostedStateValue(snapshot.payload);
  const collection = payload.instances.values().next().value.installations.values().next().value.dataCollections.get("messages");
  const records = new Map<string, unknown>();
  collection.partitions.set("instance", records);
  let lifecycleReceiptReserve = 0;
  for (const instance of payload.instances.values()) {
    if (instance.status === "active" || instance.status === "suspended") lifecycleReceiptReserve += instance.installations.size * 2;
    else if (instance.status === "delete-pending") lifecycleReceiptReserve += instance.installations.size;
  }
  const target = 16 * 1024 * 1024 - lifecycleReceiptReserve * 16 * 1024 - headroom;
  const measure = () => encoder.encode(JSON.stringify({ ...snapshot, payload: encodeHostedStateValue(payload) })).byteLength;
  let index = 0;
  while (target - measure() > 250_000) {
    records.set(`padding-${index}`, {
      recordId: `padding-${index}`,
      revision: 1,
      value: { blob: "x".repeat(240_000) },
      updatedAt: "2026-07-15T12:00:00.000Z",
      updatedBy,
    });
    index += 1;
  }
  const recordId = `padding-${index}`;
  let low = 0;
  let high = 240_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    records.set(recordId, {
      recordId,
      revision: 1,
      value: { blob: "x".repeat(middle) },
      updatedAt: "2026-07-15T12:00:00.000Z",
      updatedBy,
    });
    if (measure() <= target) low = middle;
    else high = middle - 1;
  }
  records.set(recordId, {
    recordId,
    revision: 1,
    value: { blob: "x".repeat(low) },
    updatedAt: "2026-07-15T12:00:00.000Z",
    updatedBy,
  });
  snapshot.payload = encodeHostedStateValue(payload);
  repository.state = snapshot;
}

function encodeHostedStateValue(value: any): any {
  if (value instanceof Map) return { $hostedType: "map", entries: [...value].map(([key, item]) => [encodeHostedStateValue(key), encodeHostedStateValue(item)]) };
  if (value instanceof Set) return { $hostedType: "set", values: [...value].map(encodeHostedStateValue) };
  if (Array.isArray(value)) return value.map(encodeHostedStateValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeHostedStateValue(item)]));
}

function principal(principalId: PrincipalId): EffectivePrincipal {
  return Object.freeze({ principalId, kind: "human", realm: "cloud" });
}

function assertHostedError(operation: () => unknown, code: HostedAppPlatformError["code"]): void {
  assert.throws(operation, (error: unknown) => isHostedError(error, code));
}

function isHostedError(error: unknown, code: HostedAppPlatformError["code"]): boolean {
  assert.ok(error instanceof HostedAppPlatformError);
  assert.equal(error.code, code);
  assert.equal(error.runtimeError.code, code);
  return true;
}
