import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Apps24Regular,
  ArrowSync16Regular,
  Box16Regular,
  Checkmark16Regular,
  Delete16Regular,
  Dismiss16Regular,
  Edit16Regular,
  Info16Regular,
  ShieldCheckmark16Regular,
} from "@fluentui/react-icons";

import { errorText } from "../../lib/api";
import { releaseDeletionResultToast, retainedDataPurgeResultToast, uninstallResultToast } from "../../lib/app-studio-copy";
import {
  activateLocalAppOperation,
  cancelLocalAppOperation,
  declareLocalAppProject,
  deleteLocalAppRelease,
  getLocalAppStudio,
  prepareLocalAppInstall,
  prepareLocalAppRelease,
  prepareLocalAppUpdate,
  publishLocalAppRelease,
  purgeLocalAppRetainedData,
  uninstallLocalApp,
} from "../../lib/restricted-apps";
import type {
  LocalAppInstance,
  LocalAppOperation,
  LocalAppPresentation,
  LocalAppRelease,
  LocalAppRetainedData,
  LocalAppStudioSnapshot,
  LocalAppUpdateOperation,
  RestrictedAppInstalled,
  WorkspaceSummary,
} from "../../types";
import { requestConfirm, showToast } from "../../ui/feedback";
import { workspaceIconOptionFor } from "../../workspace-icons";
import { WorkspaceIconGlyph } from "../chrome/common";

type ContinuityPolicy = "eligible" | "reset";

export function AppStudioPane({
  workspace,
  workspaces,
  active,
  previewRevision,
  fixtureMode = false,
  onAppsChanged,
  onError,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  active: boolean;
  previewRevision: string;
  fixtureMode?: boolean;
  onAppsChanged?: (workspaceId: string, runtimeInstanceId: string, apps: RestrictedAppInstalled[]) => void;
  onError: (message: string) => void;
}) {
  const ids = useId().replace(/:/g, "");
  const requestSequence = useRef(0);
  const loadedSource = useRef<{ workspaceId: string; fixtureMode: boolean } | null>(null);
  const operationToFocus = useRef<string | null>(null);
  const [studio, setStudio] = useState<LocalAppStudioSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectIcon, setProjectIcon] = useState("");
  const [releaseVersion, setReleaseVersion] = useState("");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [continuityPolicy, setContinuityPolicy] = useState<ContinuityPolicy>("eligible");
  const [recentlyPublished, setRecentlyPublished] = useState<string | null>(null);

  const workspaceById = useMemo(
    () => new Map(workspaces.map((item) => [item.id, item])),
    [workspaces],
  );
  const workspaceIdsKey = useMemo(
    () => workspaces.map((item) => item.id).sort().join("\0"),
    [workspaces],
  );
  const installTargets = useMemo(
    () => workspaces,
    [workspaces],
  );
  const installTargetIds = useMemo(
    () => new Set(installTargets.map((item) => item.id)),
    [installTargets],
  );
  const releasesByDigest = useMemo(
    () => new Map((studio?.releases ?? []).map((release) => [release.releaseDigest, release])),
    [studio?.releases],
  );
  const publishedReleases = useMemo(
    () => (studio?.releases ?? [])
      .filter((release) => release.state === "published")
      .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt)),
    [studio?.releases],
  );
  const previewFeatureIds = useMemo(
    () => new Set((studio?.previews ?? []).map((preview) => preview.manifest.id)),
    [studio?.previews],
  );
  const selectedInstance = useMemo(
    () => studio?.instances.find((instance) => instance.workspaceId === targetWorkspaceId) ?? null,
    [studio?.instances, targetWorkspaceId],
  );

  useEffect(() => {
    if (!active) return;
    const sequence = ++requestSequence.current;
    const sourceChanged = loadedSource.current?.workspaceId !== workspace.id
      || loadedSource.current?.fixtureMode !== fixtureMode;
    loadedSource.current = { workspaceId: workspace.id, fixtureMode };
    setLoading(true);
    if (sourceChanged) {
      setStudio(null);
      setEditingProject(false);
    }
    if (fixtureMode) {
      if (sourceChanged) setStudio(fixtureStudio(workspace, workspaces));
      setLoading(false);
      return () => { requestSequence.current += 1; };
    }
    void getLocalAppStudio(workspace.id)
      .then((next) => {
        if (requestSequence.current === sequence) setStudio(next);
      })
      .catch((caught) => {
        if (requestSequence.current === sequence) onError(errorText(caught));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setLoading(false);
    });
    return () => { requestSequence.current += 1; };
  }, [active, fixtureMode, previewRevision, workspace.id, workspaceIdsKey]);

  useEffect(() => {
    const project = studio?.project;
    setProjectTitle(project?.presentation.title ?? "");
    setProjectDescription(project?.presentation.description ?? "");
    setProjectIcon(project?.presentation.icon ?? "");
  }, [studio?.project?.projectId, studio?.project?.updatedAt]);

  useEffect(() => {
    if (targetWorkspaceId && installTargetIds.has(targetWorkspaceId)) return;
    const installedTarget = studio?.instances.find((instance) => installTargetIds.has(instance.workspaceId))?.workspaceId;
    setTargetWorkspaceId(installedTarget ?? installTargets[0]?.id ?? "");
  }, [installTargetIds, installTargets, studio?.instances, targetWorkspaceId]);

  useEffect(() => {
    if (!recentlyPublished) return;
    const timer = window.setTimeout(() => setRecentlyPublished(null), 700);
    return () => window.clearTimeout(timer);
  }, [recentlyPublished]);

  useEffect(() => {
    const operationId = operationToFocus.current;
    if (!operationId || !studio?.operations.some((operation) => operation.operationId === operationId)) return;
    operationToFocus.current = null;
    window.requestAnimationFrame(() => focusOperation(operationId));
  }, [studio?.operations]);

  async function refreshStudio(): Promise<LocalAppStudioSnapshot | null> {
    if (fixtureMode) return studio;
    const sequence = ++requestSequence.current;
    try {
      const next = await getLocalAppStudio(workspace.id);
      if (requestSequence.current === sequence) setStudio(next);
      return next;
    } catch (caught) {
      if (requestSequence.current === sequence) onError(errorText(caught));
      return null;
    }
  }

  async function runMutation(key: string, mutation: () => Promise<void>): Promise<void> {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await mutation();
    } catch (caught) {
      onError(errorText(caught));
    } finally {
      setBusyKey(null);
    }
  }

  function updateFixture(mutator: (current: LocalAppStudioSnapshot) => LocalAppStudioSnapshot): void {
    setStudio((current) => current ? mutator(current) : current);
  }

  async function saveProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const presentation: LocalAppPresentation = {
      title: projectTitle.trim(),
      description: projectDescription.trim() || null,
      icon: projectIcon.trim() || null,
    };
    if (!presentation.title) return;
    await runMutation("project", async () => {
      if (fixtureMode) {
        const timestamp = new Date().toISOString();
        updateFixture((current) => ({
          ...current,
          project: {
            workspaceId: workspace.id,
            projectId: current.project?.projectId ?? "project_fixture-connected-inbox",
            presentation,
            createdAt: current.project?.createdAt ?? timestamp,
            updatedAt: timestamp,
          },
        }));
      } else {
        await declareLocalAppProject(workspace.id, presentation);
        await refreshStudio();
      }
      setEditingProject(false);
      showToast({ text: studio?.project ? "App Project updated" : "App Project created", tone: "success" });
    });
  }

  async function prepareRelease(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const displayVersion = releaseVersion.trim();
    if (!displayVersion || !studio?.project || !studio.previews.length) return;
    await runMutation("release:prepare", async () => {
      if (fixtureMode) {
        const timestamp = new Date().toISOString();
        const release: LocalAppRelease = {
          projectId: studio.project!.projectId,
          sourceWorkspaceId: workspace.id,
          releaseDigest: fixtureDigest(displayVersion),
          displayVersion,
          presentation: { ...studio.project!.presentation },
          featureIds: studio.previews.map((preview) => preview.manifest.id).sort(),
          state: "prepared",
          preparedAt: timestamp,
          publishedAt: null,
        };
        updateFixture((current) => ({ ...current, releases: [release, ...current.releases] }));
      } else {
        await prepareLocalAppRelease(workspace.id, displayVersion);
        await refreshStudio();
      }
      setReleaseVersion("");
      showToast({ text: `Release ${displayVersion} is ready to review`, tone: "success" });
    });
  }

  async function publishRelease(release: LocalAppRelease): Promise<void> {
    await runMutation(`release:publish:${release.releaseDigest}`, async () => {
      if (fixtureMode) {
        const publishedAt = new Date().toISOString();
        updateFixture((current) => ({
          ...current,
          releases: current.releases.map((item) => item.releaseDigest === release.releaseDigest
            ? { ...item, state: "published", publishedAt }
            : item),
        }));
      } else {
        await publishLocalAppRelease(workspace.id, release.releaseDigest);
        await refreshStudio();
      }
      setRecentlyPublished(release.releaseDigest);
      showToast({ text: `Release ${release.displayVersion} published locally`, tone: "success" });
    });
  }

  async function deleteRelease(release: LocalAppRelease): Promise<void> {
    const blocker = studio ? releaseDeletionBlocker(studio, release) : "Refresh App Studio before deleting this Release.";
    if (blocker) {
      onError(blocker);
      return;
    }
    const confirmed = await requestConfirm({
      title: `Delete Release ${release.displayVersion}?`,
      body: "This permanently removes the immutable Release from this device. Development previews and other Releases do not change.",
      confirmLabel: "Delete Release",
      tone: "danger",
    });
    if (!confirmed) return;
    await runMutation(`release:delete:${release.releaseDigest}`, async () => {
      let result = { deleted: true, cleanupPending: false };
      if (fixtureMode) {
        updateFixture((current) => ({
          ...current,
          releases: current.releases.filter((item) => item.releaseDigest !== release.releaseDigest),
        }));
      } else {
        result = await deleteLocalAppRelease(workspace.id, release.releaseDigest);
        await refreshStudio();
      }
      showToast(releaseDeletionResultToast({ displayVersion: release.displayVersion, ...result }));
    });
  }

  async function prepareActivation(
    release: LocalAppRelease,
    targetOverride?: string,
    policyOverride?: ContinuityPolicy,
  ): Promise<void> {
    const resolvedTargetWorkspaceId = targetOverride ?? targetWorkspaceId;
    if (!resolvedTargetWorkspaceId || !installTargetIds.has(resolvedTargetWorkspaceId)) return;
    const resolvedPolicy = policyOverride ?? continuityPolicy;
    const targetInstance = studio?.instances.find((instance) => instance.workspaceId === resolvedTargetWorkspaceId) ?? null;
    await runMutation(`operation:prepare:${release.releaseDigest}`, async () => {
      let operation: LocalAppOperation;
      if (fixtureMode) {
        operation = targetInstance
          ? fixtureUpdateOperation(studio!, targetInstance, release, resolvedPolicy)
          : fixtureInstallOperation(studio!, resolvedTargetWorkspaceId, release);
        updateFixture((current) => ({ ...current, operations: [...current.operations, operation] }));
      } else if (targetInstance) {
        operation = await prepareLocalAppUpdate(
          workspace.id,
          targetInstance.runtimeInstanceId,
          release.releaseDigest,
          resolvedPolicy,
        );
        await refreshStudio();
      } else {
        operation = await prepareLocalAppInstall(workspace.id, resolvedTargetWorkspaceId, release.releaseDigest);
        await refreshStudio();
      }
      operationToFocus.current = operation.operationId;
      showToast({ text: `${targetInstance ? "Update" : "Install"} ready to review`, tone: "success" });
    });
  }

  async function activateOperation(operation: LocalAppOperation): Promise<void> {
    const release = releasesByDigest.get(operation.releaseDigest);
    const instance = studio?.instances.find((item) => item.runtimeInstanceId === operation.runtimeInstanceId) ?? null;
    const rollback = operation.kind === "update" && release && instance
      ? releaseIsOlder(release, releasesByDigest.get(instance.releaseDigest))
      : false;
    await runMutation(`operation:activate:${operation.operationId}`, async () => {
      if (fixtureMode) {
        const timestamp = new Date().toISOString();
        updateFixture((current) => {
          const target = current.releases.find((item) => item.releaseDigest === operation.releaseDigest)!;
          const nextInstance: LocalAppInstance = {
            runtimeInstanceId: operation.runtimeInstanceId,
            projectId: operation.projectId,
            workspaceId: operation.targetWorkspaceId,
            releaseDigest: target.releaseDigest,
            displayVersion: target.displayVersion,
            presentation: { ...target.presentation },
            featureIds: [...target.featureIds],
            installedAt: instance?.installedAt ?? timestamp,
            updatedAt: timestamp,
          };
          return {
            ...current,
            instances: [...current.instances.filter((item) => item.runtimeInstanceId !== operation.runtimeInstanceId), nextInstance],
            operations: current.operations.filter((item) => item.operationId !== operation.operationId),
          };
        });
      } else {
        const result = await activateLocalAppOperation(workspace.id, operation.operationId);
        onAppsChanged?.(operation.targetWorkspaceId, result.instance.runtimeInstanceId, result.apps);
        await refreshStudio();
      }
      showToast({
        text: operation.kind === "install"
          ? `Installed in ${workspaceName(operation.targetWorkspaceId, workspaceById)}`
          : rollback ? "Rollback activated" : "Update activated",
        tone: "success",
      });
    });
  }

  async function cancelOperation(operation: LocalAppOperation): Promise<void> {
    await runMutation(`operation:cancel:${operation.operationId}`, async () => {
      if (fixtureMode) {
        updateFixture((current) => ({
          ...current,
          operations: current.operations.filter((item) => item.operationId !== operation.operationId),
        }));
      } else {
        await cancelLocalAppOperation(workspace.id, operation.operationId);
        await refreshStudio();
      }
      showToast({ text: "Activation review cancelled" });
    });
  }

  async function uninstall(instance: LocalAppInstance, disposition: "retain" | "purge"): Promise<void> {
    const targetName = workspaceName(instance.workspaceId, workspaceById);
    const retained = disposition === "retain";
    const confirmed = await requestConfirm({
      title: `Uninstall ${instance.presentation.title} from ${targetName}?`,
      body: retained
        ? "The App and its authority will be removed. Its local data will stay on this device until you purge it."
        : "The App loses authority immediately. Its local data will be permanently removed from this device; interrupted cleanup retries automatically.",
      confirmLabel: retained ? "Uninstall & retain data" : "Uninstall & purge data",
      tone: "danger",
    });
    if (!confirmed) return;
    await runMutation(`uninstall:${instance.runtimeInstanceId}`, async () => {
      let result = { removed: true, cleanupPending: false };
      if (fixtureMode) {
        const timestamp = new Date().toISOString();
        const added = retained
          ? instance.featureIds.map((featureId, index): LocalAppRetainedData => ({
            retainedDataId: `retained_fixture_${index}_${Date.now()}`,
            projectId: instance.projectId,
            runtimeInstanceId: instance.runtimeInstanceId,
            featureId,
            featureInstallationId: `feature_fixture_${index}`,
            dataNamespaceId: `data_fixture_${index}`,
            releaseDigest: instance.releaseDigest,
            removedAt: timestamp,
          }))
          : [];
        updateFixture((current) => ({
          ...current,
          instances: current.instances.filter((item) => item.runtimeInstanceId !== instance.runtimeInstanceId),
          operations: current.operations.filter((item) => item.runtimeInstanceId !== instance.runtimeInstanceId),
          retainedData: [...current.retainedData, ...added],
        }));
      } else {
        result = await uninstallLocalApp(instance.workspaceId, instance.runtimeInstanceId, disposition);
        onAppsChanged?.(instance.workspaceId, instance.runtimeInstanceId, []);
        await refreshStudio();
      }
      showToast(uninstallResultToast({ ...result, disposition }));
    });
  }

  async function purgeRetainedData(item: LocalAppRetainedData): Promise<void> {
    const confirmed = await requestConfirm({
      title: `Purge retained data for ${item.featureId}?`,
      body: "This detaches the retained namespace immediately and permanently removes its data from this device. Interrupted cleanup retries automatically.",
      confirmLabel: "Purge data",
      tone: "danger",
    });
    if (!confirmed) return;
    await runMutation(`retained:${item.retainedDataId}`, async () => {
      let result = { purged: true, cleanupPending: false };
      if (fixtureMode) {
        updateFixture((current) => ({
          ...current,
          retainedData: current.retainedData.filter((entry) => entry.retainedDataId !== item.retainedDataId),
        }));
      } else {
        result = await purgeLocalAppRetainedData(workspace.id, item.retainedDataId);
        await refreshStudio();
      }
      showToast(retainedDataPurgeResultToast(result));
    });
  }

  function focusOperation(operationId: string): void {
    const element = document.getElementById(`${ids}-app-studio-operation-${operationId}`);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    element?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    element?.focus({ preventScroll: true });
  }

  if (loading && !studio) {
    return (
      <div className="workspace-pane-content professional-surface app-studio-pane">
        <div className="app-studio-loading" role="status"><ArrowSync16Regular className="spin" />Loading App Studio</div>
      </div>
    );
  }

  const project = studio?.project ?? null;
  const projectIconOption = workspaceIconOptionFor(project?.presentation.icon ?? "apps");
  const hasInstallTarget = Boolean(targetWorkspaceId && installTargetIds.has(targetWorkspaceId));
  const targetName = hasInstallTarget ? workspaceName(targetWorkspaceId, workspaceById) : "";
  const pendingForTarget = hasInstallTarget
    ? studio?.operations.find((operation) => operation.targetWorkspaceId === targetWorkspaceId) ?? null
    : null;

  return (
    <div className="workspace-pane-content professional-surface app-studio-pane">
      <section className="app-studio-canvas" aria-labelledby={`${ids}-title`}>
        <header className="app-studio-header">
          <div className="app-studio-project-identity">
            <span className="app-studio-project-mark" aria-hidden="true"><WorkspaceIconGlyph icon={projectIconOption.Icon} size={24} filled /></span>
            <div>
              <span className="professional-kicker">Local App Studio</span>
              <h1 id={`${ids}-title`}>{project?.presentation.title ?? "Create an App Project"}</h1>
              <p>{project?.presentation.description ?? `Build and release a local App from reviewed previews in ${workspace.name}.`}</p>
              {project ? <small>Project in {workspace.name} · Releases stay on this device</small> : null}
            </div>
          </div>
          <div className="app-studio-header-actions">
            {project ? (
              <button className="professional-button professional-button-secondary" type="button" onClick={() => setEditingProject((current) => !current)} disabled={Boolean(busyKey)}>
                {editingProject ? <Dismiss16Regular /> : <Edit16Regular />}{editingProject ? "Close editor" : "Edit Project"}
              </button>
            ) : null}
            {!fixtureMode ? (
              <button className="app-studio-icon-button" type="button" onClick={() => void refreshStudio()} disabled={Boolean(busyKey)} aria-label="Refresh App Studio" title="Refresh App Studio">
                <ArrowSync16Regular />
              </button>
            ) : null}
          </div>
        </header>

        {!project || editingProject ? (
          <ProjectEditor
            ids={ids}
            creating={!project}
            title={projectTitle}
            description={projectDescription}
            icon={projectIcon}
            busy={busyKey === "project"}
            onTitleChange={setProjectTitle}
            onDescriptionChange={setProjectDescription}
            onIconChange={setProjectIcon}
            onSubmit={(event) => void saveProject(event)}
            onCancel={project ? () => {
              setProjectTitle(project.presentation.title);
              setProjectDescription(project.presentation.description ?? "");
              setProjectIcon(project.presentation.icon ?? "");
              setEditingProject(false);
            } : undefined}
          />
        ) : null}

        {project ? (
          <>
            <section className="app-studio-stage" aria-labelledby={`${ids}-build-title`}>
              <StageNumber value="01" />
              <div className="app-studio-stage-body">
                <StageHeader
                  titleId={`${ids}-build-title`}
                  title="Build"
                  description="Reviewed sandboxed Features in this Space make up the development preview."
                  status={`${studio?.previews.length ?? 0} preview${studio?.previews.length === 1 ? "" : "s"}`}
                />
                {studio?.previews.length ? (
                  <div className="app-studio-row-list" aria-label="Development previews">
                    {studio.previews.map((preview) => (
                      <article className="app-studio-row" key={preview.featureInstallationId}>
                        <span className="app-studio-row-icon" aria-hidden="true"><Box16Regular /></span>
                        <div className="app-studio-row-copy">
                          <div className="app-studio-row-title">
                            <strong>{preview.manifest.title}</strong>
                            <span className="professional-status-badge enabled">Local preview</span>
                          </div>
                          <p>{preview.manifest.description ?? "Sandboxed Feature ready for local release."}</p>
                          <small>{preview.manifest.id} · package {preview.version} · reviewed digest {shortDigest(preview.digest)}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="app-studio-empty-row">
                    <Box16Regular aria-hidden="true" />
                    <div><strong>No development previews</strong><p>Review and add a sandboxed app in Assistant tools before preparing a Release.</p></div>
                  </div>
                )}
                <form className="app-studio-release-form" onSubmit={(event) => void prepareRelease(event)}>
                  <label htmlFor={`${ids}-release-version`}>
                    <span>Release version</span>
                    <input
                      id={`${ids}-release-version`}
                      value={releaseVersion}
                      onChange={(event) => setReleaseVersion(event.target.value)}
                      maxLength={128}
                      placeholder="0.1.0"
                      autoComplete="off"
                      disabled={Boolean(busyKey)}
                    />
                  </label>
                  <button className="professional-button professional-button-primary" type="submit" disabled={Boolean(busyKey) || !releaseVersion.trim() || !studio?.previews.length}>
                    {busyKey === "release:prepare" ? <ArrowSync16Regular className="spin" /> : null}Prepare Release
                  </button>
                  <p><Info16Regular aria-hidden="true" />Preparing freezes the exact reviewed preview. You will review it again before publishing locally.</p>
                </form>
              </div>
            </section>

            <section className="app-studio-stage" aria-labelledby={`${ids}-releases-title`}>
              <StageNumber value="02" />
              <div className="app-studio-stage-body">
                <StageHeader
                  titleId={`${ids}-releases-title`}
                  title="Releases"
                  description="Immutable local versions. Publishing makes a Release available to install; it does not activate anything."
                  status={`${studio?.releases.length ?? 0} total`}
                />
                <div className="app-studio-target-bar">
                  <label htmlFor={`${ids}-target-space`}>
                    <span>Install in Space</span>
                    <select id={`${ids}-target-space`} value={targetWorkspaceId} onChange={(event) => setTargetWorkspaceId(event.target.value)} disabled={Boolean(busyKey) || !installTargets.length}>
                      {installTargets.length
                        ? installTargets.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)
                        : <option value="">No Spaces registered</option>}
                    </select>
                  </label>
                  {selectedInstance ? (
                    <label htmlFor={`${ids}-continuity`}>
                      <span>Update access</span>
                      <select id={`${ids}-continuity`} value={continuityPolicy} onChange={(event) => setContinuityPolicy(event.target.value as ContinuityPolicy)} disabled={Boolean(busyKey)}>
                        <option value="eligible">Keep only eligible access</option>
                        <option value="reset">Reset all access</option>
                      </select>
                    </label>
                  ) : null}
                  <p>{!hasInstallTarget
                    ? "Add or register a Space to install this App."
                    : targetWorkspaceId === workspace.id && Boolean(studio?.previews.length)
                      ? "This is the source Space. Remove any conflicting local preview before installing a Release here."
                    : selectedInstance
                      ? `${selectedInstance.presentation.title} ${selectedInstance.displayVersion} is active in ${targetName}.`
                      : `No installed App Instance in ${targetName}. A new install starts with fresh data and all powers off.`}</p>
                </div>
                {studio?.releases.length ? (
                  <div className="app-studio-release-list">
                    {studio.releases.map((release) => {
                      const active = selectedInstance?.releaseDigest === release.releaseDigest;
                      const rollback = selectedInstance ? releaseIsOlder(release, releasesByDigest.get(selectedInstance.releaseDigest)) : false;
                      const pending = studio.operations.find((operation) => operation.targetWorkspaceId === targetWorkspaceId && operation.releaseDigest === release.releaseDigest);
                      const blockedByOtherPending = pending ? null : pendingForTarget;
                      const sourcePreviewCollision = !selectedInstance
                        && targetWorkspaceId === workspace.id
                        && release.featureIds.some((featureId) => previewFeatureIds.has(featureId));
                      const deletionBlocker = releaseDeletionBlocker(studio, release);
                      return (
                        <article
                          className={`app-studio-release-row${recentlyPublished === release.releaseDigest ? " recently-published" : ""}`}
                          data-state={release.state}
                          key={release.releaseDigest}
                        >
                          <div className="app-studio-release-main">
                            <div className="app-studio-row-title">
                              <strong>{release.displayVersion}</strong>
                              <span className={release.state === "published" ? "professional-status-badge enabled" : "professional-status-badge"}>{release.state === "published" ? "Published locally" : "Prepared"}</span>
                              {active ? <span className="app-studio-active-label"><Checkmark16Regular />Active in {targetName}</span> : null}
                            </div>
                            <p>{release.presentation.title} · {formatCount(release.featureIds.length, "Feature")}</p>
                            <small>{formatTimestamp(release.publishedAt ?? release.preparedAt)} · {shortDigest(release.releaseDigest)}</small>
                          </div>
                          <div className="app-studio-release-action">
                            {release.state === "published" ? (
                              active ? (
                                <span className="app-studio-quiet-state">Current Release</span>
                              ) : pending || blockedByOtherPending ? (
                                <button className="professional-button professional-button-secondary" type="button" disabled={Boolean(busyKey)} onClick={() => focusOperation((pending ?? blockedByOtherPending)!.operationId)}>
                                  Open review
                                </button>
                              ) : (
                                <button className="professional-button professional-button-secondary" type="button" disabled={Boolean(busyKey) || !hasInstallTarget || sourcePreviewCollision} onClick={() => void prepareActivation(release)}>
                                  {busyKey === `operation:prepare:${release.releaseDigest}` ? <ArrowSync16Regular className="spin" /> : null}
                                  {sourcePreviewCollision ? "Remove conflicting preview" : selectedInstance ? `Review ${rollback ? "rollback" : "update"}` : "Review install"}
                                </button>
                              )
                            ) : null}
                            <button
                              className="app-studio-icon-button danger"
                              type="button"
                              disabled={Boolean(busyKey)}
                              aria-disabled={Boolean(deletionBlocker)}
                              onClick={() => void deleteRelease(release)}
                              aria-label={deletionBlocker
                                ? `Cannot delete Release ${release.displayVersion}. ${deletionBlocker}`
                                : `Delete Release ${release.displayVersion}`}
                              title={deletionBlocker ?? `Delete Release ${release.displayVersion}`}
                            >
                              {busyKey === `release:delete:${release.releaseDigest}` ? <ArrowSync16Regular className="spin" /> : <Delete16Regular />}
                            </button>
                          </div>
                          {release.state === "prepared" ? (
                            <details className="app-studio-release-review" open>
                              <summary>Review prepared Release</summary>
                              <div>
                                <dl className="app-studio-facts">
                                  <div><dt>App</dt><dd>{release.presentation.title}</dd></div>
                                  <div><dt>Version</dt><dd>{release.displayVersion}</dd></div>
                                  <div><dt>Features</dt><dd>{release.featureIds.join(", ")}</dd></div>
                                  <div><dt>Release digest</dt><dd><code>{release.releaseDigest}</code></dd></div>
                                </dl>
                                <p><ShieldCheckmark16Regular aria-hidden="true" />Publishing records this immutable Release locally. It grants no access and starts no automation.</p>
                                <button className="professional-button professional-button-primary" type="button" disabled={Boolean(busyKey)} onClick={() => void publishRelease(release)}>
                                  {busyKey === `release:publish:${release.releaseDigest}` ? <ArrowSync16Regular className="spin" /> : null}Publish locally
                                </button>
                              </div>
                            </details>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="app-studio-empty-row"><Box16Regular aria-hidden="true" /><div><strong>No Releases yet</strong><p>Prepare a version from the reviewed development preview above.</p></div></div>
                )}
              </div>
            </section>

            <section className="app-studio-stage" aria-labelledby={`${ids}-installations-title`}>
              <StageNumber value="03" />
              <div className="app-studio-stage-body">
                <StageHeader
                  titleId={`${ids}-installations-title`}
                  title="Installations"
                  description="Each Space gets an independent App Instance, authority, automations, and local data."
                  status={`${studio?.instances.length ?? 0} installed`}
                />

                {studio?.operations.length ? (
                  <div className="app-studio-operation-list" aria-label="Activation reviews">
                    {studio.operations.map((operation) => (
                      <OperationReview
                        key={operation.operationId}
                        idPrefix={ids}
                        operation={operation}
                        release={releasesByDigest.get(operation.releaseDigest)}
                        activeRelease={releasesByDigest.get(studio.instances.find((item) => item.runtimeInstanceId === operation.runtimeInstanceId)?.releaseDigest ?? "")}
                        targetName={workspaceName(operation.targetWorkspaceId, workspaceById)}
                        busyKey={busyKey}
                        onActivate={() => void activateOperation(operation)}
                        onCancel={() => void cancelOperation(operation)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="app-studio-no-review"><Checkmark16Regular aria-hidden="true" />No activation reviews are waiting. Preparing an install, update, or rollback creates one here.</p>
                )}

                {studio?.instances.length ? (
                  <div className="app-studio-installation-list" aria-label="Installed App Instances">
                    {studio.instances.map((instance) => {
                      const instanceWorkspaceName = workspaceName(instance.workspaceId, workspaceById);
                      const latest = publishedReleases[0];
                      const updateAvailable = latest && latest.releaseDigest !== instance.releaseDigest
                        && !releaseIsOlder(latest, releasesByDigest.get(instance.releaseDigest));
                      const pending = studio.operations.find((operation) => operation.runtimeInstanceId === instance.runtimeInstanceId);
                      return (
                        <article className={`app-studio-installation-row${instance.workspaceId === targetWorkspaceId ? " selected" : ""}`} key={instance.runtimeInstanceId}>
                          <div className="app-studio-installation-copy">
                            <div className="app-studio-row-title">
                              <strong>{instance.presentation.title}</strong>
                              <span className="professional-status-badge enabled">{instance.displayVersion}</span>
                              {updateAvailable ? <span className="professional-status-badge">Update available</span> : null}
                            </div>
                            <p>Installed in {instanceWorkspaceName} · Data on this device</p>
                            <small>{formatCount(instance.featureIds.length, "Feature")} · Updated {formatTimestamp(instance.updatedAt)} · {shortDigest(instance.releaseDigest)}</small>
                          </div>
                          <div className="app-studio-installation-actions">
                            {instance.workspaceId !== targetWorkspaceId && !updateAvailable ? (
                              <button className="app-studio-text-button" type="button" disabled={Boolean(busyKey)} onClick={() => setTargetWorkspaceId(instance.workspaceId)}>Choose Space</button>
                            ) : null}
                            {updateAvailable && !pending ? (
                              <button className="professional-button professional-button-secondary" type="button" disabled={Boolean(busyKey)} onClick={() => {
                                setTargetWorkspaceId(instance.workspaceId);
                                window.requestAnimationFrame(() => document.getElementById(`${ids}-releases-title`)?.scrollIntoView({ block: "start" }));
                              }}>
                                Review in Releases
                              </button>
                            ) : null}
                            <button className="professional-button professional-button-secondary" type="button" disabled={Boolean(busyKey)} onClick={() => void uninstall(instance, "retain")}>Uninstall · retain data</button>
                            <button className="app-studio-icon-button danger" type="button" disabled={Boolean(busyKey)} onClick={() => void uninstall(instance, "purge")} aria-label={`Uninstall ${instance.presentation.title} from ${instanceWorkspaceName} and purge its data`} title="Uninstall and purge data">
                              {busyKey === `uninstall:${instance.runtimeInstanceId}` ? <ArrowSync16Regular className="spin" /> : <Delete16Regular />}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="app-studio-empty-row"><Apps24Regular aria-hidden="true" /><div><strong>No App Instances</strong><p>{hasInstallTarget ? "Choose a published Release and a target Space above, then review the install before activating it." : "Add or register a Space, then return here to review a local install."}</p></div></div>
                )}

                <div className="app-studio-retained-heading">
                  <div><h3>Detached local data</h3><p>Data without active Feature authority stays inert on this device until you purge it.</p></div>
                  <span>{studio?.retainedData.length ?? 0}</span>
                </div>
                {studio?.retainedData.length ? (
                  <div className="app-studio-retained-list">
                    {studio.retainedData.map((item) => (
                      <article className="app-studio-retained-row" key={item.retainedDataId}>
                        <div>
                          <strong>{item.featureId}</strong>
                          <p>No active Feature authority · Data on this device</p>
                          <small>Retained {formatTimestamp(item.removedAt)} · Release {shortDigest(item.releaseDigest)}</small>
                        </div>
                        <button className="professional-button professional-button-danger" type="button" disabled={Boolean(busyKey)} onClick={() => void purgeRetainedData(item)}>
                          {busyKey === `retained:${item.retainedDataId}` ? <ArrowSync16Regular className="spin" /> : <Delete16Regular />}Purge data
                        </button>
                      </article>
                    ))}
                  </div>
                ) : <p className="app-studio-retained-empty">No retained App data.</p>}
              </div>
            </section>
          </>
        ) : null}
      </section>
    </div>
  );
}

function ProjectEditor({
  ids,
  creating,
  title,
  description,
  icon,
  busy,
  onTitleChange,
  onDescriptionChange,
  onIconChange,
  onSubmit,
  onCancel,
}: {
  ids: string;
  creating: boolean;
  title: string;
  description: string;
  icon: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onIconChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
}) {
  return (
    <section className={`app-studio-project-editor${creating ? " creating" : ""}`} aria-labelledby={`${ids}-project-editor-title`}>
      <div className="app-studio-project-editor-copy">
        <span className="app-studio-project-editor-icon" aria-hidden="true"><Apps24Regular /></span>
        <div>
          <h2 id={`${ids}-project-editor-title`}>{creating ? "Name this App Project" : "Project presentation"}</h2>
          <p>{creating ? "This machine-local Project groups the previews and Releases built from this Space." : "These details are frozen into every new Release. Existing Releases do not change."}</p>
        </div>
      </div>
      <form className="app-studio-project-form" onSubmit={onSubmit}>
        <label htmlFor={`${ids}-project-title`}>
          <span>App name</span>
          <input id={`${ids}-project-title`} value={title} onChange={(event) => onTitleChange(event.target.value)} maxLength={80} required disabled={busy} autoFocus={creating} />
        </label>
        <label className="wide" htmlFor={`${ids}-project-description`}>
          <span>Description <small>Optional</small></span>
          <textarea id={`${ids}-project-description`} value={description} onChange={(event) => onDescriptionChange(event.target.value)} maxLength={280} rows={3} disabled={busy} />
        </label>
        <label htmlFor={`${ids}-project-icon`}>
          <span>Icon id <small>Optional</small></span>
          <input id={`${ids}-project-icon`} value={icon} onChange={(event) => onIconChange(event.target.value.toLocaleLowerCase())} maxLength={64} pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="apps" disabled={busy} autoComplete="off" />
          <small>Lowercase letters, numbers, and hyphens.</small>
        </label>
        <div className="app-studio-project-form-actions">
          {onCancel ? <button className="professional-button professional-button-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button> : null}
          <button className="professional-button professional-button-primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? <ArrowSync16Regular className="spin" /> : null}{creating ? "Create App Project" : "Save Project"}
          </button>
        </div>
      </form>
    </section>
  );
}

function StageNumber({ value }: { value: string }) {
  return <span className="app-studio-stage-number" aria-hidden="true">{value}</span>;
}

function StageHeader({ titleId, title, description, status }: { titleId: string; title: string; description: string; status: string }) {
  return (
    <header className="app-studio-stage-header">
      <div><h2 id={titleId}>{title}</h2><p>{description}</p></div>
      <span>{status}</span>
    </header>
  );
}

function OperationReview({
  idPrefix,
  operation,
  release,
  activeRelease,
  targetName,
  busyKey,
  onActivate,
  onCancel,
}: {
  idPrefix: string;
  operation: LocalAppOperation;
  release?: LocalAppRelease;
  activeRelease?: LocalAppRelease;
  targetName: string;
  busyKey: string | null;
  onActivate: () => void;
  onCancel: () => void;
}) {
  const update = operation.kind === "update" ? operation : null;
  const rollback = update && release ? releaseIsOlder(release, activeRelease) : false;
  const label = operation.kind === "install" ? "Install" : rollback ? "Rollback" : "Update";
  const canActivate = !update || update.plan.canCommit;
  const operationDomId = `${idPrefix}-app-studio-operation-${operation.operationId}`;
  const titleDomId = `${idPrefix}-app-studio-operation-title-${operation.operationId}`;
  return (
    <article
      className="app-studio-operation-review"
      id={operationDomId}
      tabIndex={-1}
      aria-labelledby={titleDomId}
    >
      <header>
        <div>
          <span className="app-studio-operation-eyebrow">Activation review</span>
          <h3 id={titleDomId}>{label} {release?.displayVersion ?? "Release"} in {targetName}</h3>
          <p>Prepared {formatTimestamp(operation.preparedAt)} · You can leave App Studio and resume this review later.</p>
        </div>
        <span className={canActivate ? "professional-status-badge enabled" : "professional-status-badge error"}>{canActivate ? "Ready" : "Blocked"}</span>
      </header>
      <dl className="app-studio-facts compact">
        <div><dt>Target Space</dt><dd>{targetName}</dd></div>
        <div><dt>Release</dt><dd>{release?.displayVersion ?? shortDigest(operation.releaseDigest)}</dd></div>
        <div><dt>Local data</dt><dd>{operation.kind === "install" ? "Fresh namespace" : "Per plan below"}</dd></div>
        <div><dt>Authority</dt><dd>{operation.kind === "install" ? "All powers off" : operation.continuityPolicy === "eligible" ? "Eligible only" : "Reset all"}</dd></div>
      </dl>
      {operation.kind === "install" ? (
        <p className="app-studio-authority-note"><ShieldCheckmark16Regular aria-hidden="true" />A new App Instance will be created. File access, network access, connections, notifications, and every named automation start off.</p>
      ) : (
        <UpdatePlan operation={operation} />
      )}
      <footer>
        <button className="professional-button professional-button-secondary" type="button" disabled={Boolean(busyKey)} onClick={onCancel}>
          {busyKey === `operation:cancel:${operation.operationId}` ? <ArrowSync16Regular className="spin" /> : null}Cancel review
        </button>
        <button className="professional-button professional-button-primary" type="button" disabled={Boolean(busyKey) || !canActivate} onClick={onActivate}>
          {busyKey === `operation:activate:${operation.operationId}` ? <ArrowSync16Regular className="spin" /> : null}Activate {label.toLocaleLowerCase()}
        </button>
      </footer>
    </article>
  );
}

function UpdatePlan({ operation }: { operation: LocalAppUpdateOperation }) {
  return (
    <div className="app-studio-update-plan">
      <div className="app-studio-update-plan-heading">
        <div><strong>Update plan</strong><span>Exact plan {shortDigest(operation.plan.planDigest)}</span></div>
        <span>{formatCount(operation.plan.transitions.length, "Feature change")}</span>
      </div>
      <div className="app-studio-transition-list">
        {operation.plan.transitions.map((transition) => {
          const continuity = transition.continuity.grants.length + transition.continuity.connections.length + transition.continuity.enabledJobs.length;
          return (
            <div className="app-studio-transition-row" key={transition.featureId}>
              <div><strong>{transition.featureId}</strong><small>{transition.action} · data: {transition.data}</small></div>
              <div className="app-studio-continuity-detail">
                {continuity ? (
                  <>
                    {transition.continuity.grants.length ? <span><b>Grants</b>{transition.continuity.grants.join(", ")}</span> : null}
                    {transition.continuity.connections.length ? <span><b>Connections</b>{transition.continuity.connections.join(", ")}</span> : null}
                    {transition.continuity.enabledJobs.length ? <span><b>Enabled jobs</b>{transition.continuity.enabledJobs.join(", ")}</span> : null}
                  </>
                ) : <span>No state carried</span>}
              </div>
              <span className={transition.resets.length ? "reset" : ""}>{transition.resets.length ? `Reset ${transition.resets.join(", ")}` : "No reset"}</span>
            </div>
          );
        })}
      </div>
      {operation.plan.blockedReasons.length ? (
        <div className="app-studio-blocked-reasons" role="alert">
          <strong>This plan cannot activate</strong>
          {operation.plan.blockedReasons.map((reason) => <p key={reason}>{reason}</p>)}
        </div>
      ) : (
        <p className="app-studio-authority-note"><ShieldCheckmark16Regular aria-hidden="true" />Exact eligible grants, connections, and jobs are listed by Feature. Anything marked Reset starts off in the target Release.</p>
      )}
    </div>
  );
}

function releaseIsOlder(target: LocalAppRelease, active?: LocalAppRelease): boolean {
  if (!active) return false;
  return target.preparedAt.localeCompare(active.preparedAt) < 0;
}

function releaseDeletionBlocker(studio: LocalAppStudioSnapshot, release: LocalAppRelease): string | null {
  if (studio.instances.some((instance) => instance.releaseDigest === release.releaseDigest)) {
    return "Uninstall every App Instance using it first.";
  }
  if (studio.operations.some((operation) => (
    operation.releaseDigest === release.releaseDigest
    || (operation.kind === "update" && operation.plan.fromReleaseDigest === release.releaseDigest)
  ))) {
    return "Cancel every prepared install, update, or rollback using it first.";
  }
  if (studio.retainedData.some((item) => item.releaseDigest === release.releaseDigest)) {
    return "Purge the retained App data that records it first.";
  }
  return null;
}

function workspaceName(workspaceId: string, byId: ReadonlyMap<string, WorkspaceSummary>): string {
  return byId.get(workspaceId)?.name ?? "Unavailable Space";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function shortDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice(7) : value;
  return `${digest.slice(0, 10)}…`;
}

function fixtureStudio(workspace: WorkspaceSummary, workspaces: WorkspaceSummary[]): LocalAppStudioSnapshot {
  const sourceTimestamp = workspace.updatedAt || "2026-07-16T14:00:00.000Z";
  const target = workspaces.find((item) => item.id !== workspace.id) ?? null;
  const projectId = "project_fixture-connected-inbox";
  const presentation: LocalAppPresentation = {
    title: "Connected Inbox",
    description: "Sort incoming requests and keep the next action visible.",
    icon: "mail-inbox",
  };
  const oldRelease: LocalAppRelease = {
    projectId,
    sourceWorkspaceId: workspace.id,
    releaseDigest: fixtureDigest("0.3.0"),
    displayVersion: "0.3.0",
    presentation,
    featureIds: ["inbox-triage"],
    state: "published",
    preparedAt: "2026-07-02T14:00:00.000Z",
    publishedAt: "2026-07-02T14:10:00.000Z",
  };
  const currentRelease: LocalAppRelease = {
    ...oldRelease,
    releaseDigest: fixtureDigest("0.4.0"),
    displayVersion: "0.4.0",
    preparedAt: "2026-07-14T14:00:00.000Z",
    publishedAt: "2026-07-14T14:10:00.000Z",
  };
  const preparedRelease: LocalAppRelease = {
    ...oldRelease,
    releaseDigest: fixtureDigest("0.5.0"),
    displayVersion: "0.5.0",
    state: "prepared",
    preparedAt: "2026-07-16T13:30:00.000Z",
    publishedAt: null,
  };
  const preview = fixturePreview(workspace.id, projectId, sourceTimestamp);
  const instance: LocalAppInstance | null = target ? {
    runtimeInstanceId: "runtime_fixture-connected-inbox",
    projectId,
    workspaceId: target.id,
    releaseDigest: oldRelease.releaseDigest,
    displayVersion: oldRelease.displayVersion,
    presentation,
    featureIds: ["inbox-triage"],
    installedAt: "2026-07-03T14:00:00.000Z",
    updatedAt: "2026-07-03T14:00:00.000Z",
  } : null;
  const update = instance
    ? fixtureUpdateOperation(
      { project: null, previews: [], releases: [currentRelease, oldRelease], instances: [instance], operations: [], retainedData: [] },
      instance,
      currentRelease,
      "eligible",
    )
    : null;
  return {
    project: { workspaceId: workspace.id, projectId, presentation, createdAt: sourceTimestamp, updatedAt: sourceTimestamp },
    previews: [preview],
    releases: [preparedRelease, currentRelease, oldRelease],
    instances: instance ? [instance] : [],
    operations: update ? [update] : [],
    retainedData: [{
      retainedDataId: "retained_fixture-summary-panel",
      projectId,
      runtimeInstanceId: "runtime_fixture-prior",
      featureId: "summary-panel",
      featureInstallationId: "feature_fixture-summary-panel",
      dataNamespaceId: "data_fixture-summary-panel",
      releaseDigest: fixtureDigest("0.2.0"),
      removedAt: "2026-07-01T12:00:00.000Z",
    }],
  };
}

function fixturePreview(workspaceId: string, projectId: string, timestamp: string): RestrictedAppInstalled {
  const generation = "00000000-0000-4000-8000-000000000001";
  return {
    workspaceId,
    sourceWorkspaceId: workspaceId,
    projectId,
    tenantId: "tenant_fixture",
    principalId: "principal_fixture",
    runtimeInstanceId: "runtime_fixture-preview",
    runtimeInstanceKind: "development",
    releaseDigest: null,
    featureInstallationId: "feature_fixture-preview",
    dataNamespaceId: "data_fixture-preview",
    authority: {
      runtimeInstanceGeneration: generation,
      featureInstallationGeneration: generation,
      grantGeneration: generation,
      connectionGeneration: generation,
      jobGeneration: generation,
      principalGeneration: generation,
      dataGeneration: generation,
    },
    packageName: "@workspace-examples/connected-inbox",
    version: "0.5.0-preview.2",
    digest: fixtureDigest("preview-package"),
    artifactDigest: fixtureDigest("preview-artifact"),
    manifest: {
      version: 2,
      id: "inbox-triage",
      title: "Inbox triage",
      description: "Groups incoming requests and suggests the next action.",
      runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
      ui: { icon: "mail-inbox" },
      tools: [],
      automations: [{
        id: "daily-triage",
        title: "Daily triage",
        description: "Refresh the inbox summary each morning.",
        handler: "dailyTriage",
        trigger: { kind: "interval", intervalMinutes: 1440 },
        permissions: { network: [], files: [], notifications: [] },
        catchUp: "latest",
        overlap: "skip",
      }],
      permissions: { network: [], files: [], notifications: [] },
    },
    networkGrants: [],
    fileGrants: [],
    notificationGrants: [],
    automations: [{ id: "daily-triage", enabled: false }],
    installedAt: timestamp,
    updatedAt: timestamp,
    fileCount: 4,
    totalBytes: 18_420,
  };
}

function fixtureInstallOperation(studio: LocalAppStudioSnapshot, targetWorkspaceId: string, release: LocalAppRelease): LocalAppOperation {
  return {
    operationId: `operation_fixture_install_${Date.now()}`,
    kind: "install",
    projectId: studio.project!.projectId,
    targetWorkspaceId,
    releaseDigest: release.releaseDigest,
    runtimeInstanceId: `runtime_fixture_${Date.now()}`,
    features: release.featureIds.map((featureId, index) => ({
      featureId,
      featureInstallationId: `feature_fixture_${index}_${Date.now()}`,
      dataNamespaceId: `data_fixture_${index}_${Date.now()}`,
    })),
    preparedAt: new Date().toISOString(),
  };
}

function fixtureUpdateOperation(
  studio: LocalAppStudioSnapshot,
  instance: LocalAppInstance,
  release: LocalAppRelease,
  continuityPolicy: ContinuityPolicy,
): LocalAppUpdateOperation {
  const currentIds = new Set(instance.featureIds);
  const targetIds = new Set(release.featureIds);
  const featureIds = [...new Set([...instance.featureIds, ...release.featureIds])].sort();
  return {
    operationId: `operation_fixture_update_${release.displayVersion.replace(/[^a-z0-9]/gi, "-")}`,
    kind: "update",
    projectId: studio.project?.projectId ?? instance.projectId,
    targetWorkspaceId: instance.workspaceId,
    releaseDigest: release.releaseDigest,
    runtimeInstanceId: instance.runtimeInstanceId,
    continuityPolicy,
    plan: {
      planDigest: fixtureDigest(`plan-${release.displayVersion}-${continuityPolicy}`),
      fromReleaseDigest: instance.releaseDigest,
      toReleaseDigest: release.releaseDigest,
      canCommit: true,
      blockedReasons: [],
      transitions: featureIds.map((featureId) => ({
        featureId,
        action: !currentIds.has(featureId) ? "add" : !targetIds.has(featureId) ? "remove" : "update",
        data: !currentIds.has(featureId) ? "create" : !targetIds.has(featureId) ? "retain-disabled" : "retain",
        continuity: continuityPolicy === "eligible"
          ? { grants: ["eligible grants"], connections: [], enabledJobs: [] }
          : { grants: [], connections: [], enabledJobs: [] },
        resets: continuityPolicy === "reset" ? ["grants", "connections", "jobs"] : ["connections", "jobs"],
      })),
    },
    preparedAt: new Date().toISOString(),
  };
}

function fixtureDigest(seed: string): string {
  let value = 2_166_136_261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16_777_619);
  }
  return `sha256:${(value >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
