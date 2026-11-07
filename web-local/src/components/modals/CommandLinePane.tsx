import { useEffect, useState } from "react";
import { ArrowClockwise20Regular, Checkmark16Regular } from "@fluentui/react-icons";

import { productIdentity } from "../../../../src/shared/product-identity";
import { outsideAgentSkill } from "../../../../src/shared/outside-agent-skill";
import { errorText } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { showToast } from "../../ui/feedback";

type CommandLineStatus = Awaited<ReturnType<NonNullable<NonNullable<Window["workFoldDesktop"]>["commandLine"]>["status"]>>;
type SkillTarget = "claude" | "codex";

const product = productIdentity.productName;
const command = productIdentity.cliCommand;
const agents: Array<{ target: SkillTarget; name: string }> = [
  { target: "claude", name: "Claude Code" },
  { target: "codex", name: "Codex" },
];

/** The browser preview: an installed app whose command and skill aren't added yet. */
function fixtureStatus(): CommandLineStatus {
  return {
    command,
    path: { supported: true, reason: null, state: "missing", binDirectory: `/Applications/${product}.app/Contents/bin`, entryFile: `/etc/paths.d/${command}` },
    skills: {
      claude: { available: true, installed: "none", path: `~/.claude/skills/${command}/SKILL.md` },
      codex: { available: true, installed: "none", path: `~/.codex/skills/${command}/SKILL.md` },
    },
  };
}

/**
 * Settings → Command Line, and the same rows in first run (owner request,
 * 2026-11-07): let other AI agents use this app. One row adds the command to
 * Terminal (macOS asks for the person's password once); the others put the
 * skill file into Claude Code and Codex, or copy it for any other agent.
 * Nothing changes until the person clicks.
 */
export function CommandLinePane({ fixtureMode = false, compact = false }: { fixtureMode?: boolean; compact?: boolean }) {
  const bridge = window.workFoldDesktop?.commandLine;
  const [status, setStatus] = useState<CommandLineStatus | null>(() => fixtureMode ? fixtureStatus() : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);

  useEffect(() => {
    if (fixtureMode || !bridge) return;
    let cancelled = false;
    void bridge.status().then((next) => { if (!cancelled) setStatus(next); }, (caught: unknown) => { if (!cancelled) setError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [bridge, fixtureMode]);

  async function run(label: string, action: () => Promise<CommandLineStatus>, done: string) {
    if (fixtureMode) { showToast({ text: "Changing this is disabled in the preview", tone: "info" }); return; }
    setBusy(label);
    setError(null);
    try {
      setStatus(await action());
      showToast({ text: done, tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function copySkill() {
    try {
      await copyToClipboard({ text: bridge && !fixtureMode ? await bridge.skill() : outsideAgentSkill() });
      showToast({ text: "Skill copied", tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  if (!bridge && !fixtureMode) {
    return <section className="settings-section command-line-pane"><p>Adding {command} to Terminal and to other AI agents needs the {product} desktop app.</p></section>;
  }
  const path = status?.path;
  const pathLabel = !path ? "Checking" : !path.supported ? "Not available here" : path.state === "installed" ? "Added" : path.state === "elsewhere" ? "Points to another copy" : "Not added";

  return (
    <div className={`command-line-pane${compact ? " is-compact" : ""}`}>
      {compact ? null : <p className="command-line-intro">Let Claude Code, Codex, and other AI agents use {product}: they run the <code>{command}</code> command to hand work to your Workers, follow it, and run Automations.</p>}
      {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      <section className="settings-section" aria-labelledby="command-line-terminal">
      <div className="settings-section-heading"><h3 id="command-line-terminal">Terminal</h3></div>
      <div className="settings-list">
        <div className="settings-list-row">
          <div>
            <strong>Add <code>{command}</code> to Terminal</strong>
            <small>{path && !path.supported ? path.reason : path?.state === "installed" ? "Open a new Terminal window to use it." : "macOS asks for your password once."}</small>
          </div>
          <div className="settings-actions">
            <span className={`command-line-state${path?.state === "installed" ? " is-on" : ""}`}>{path?.state === "installed" ? <Checkmark16Regular aria-hidden="true" /> : null}{pathLabel}</span>
            {path?.supported && path.state !== "installed" ? (
              <button className="ui-control ui-control--primary" type="button" disabled={Boolean(busy)} onClick={() => void run("path", () => bridge!.installPath(), `${command} is in Terminal. Open a new window to use it.`)}>
                {busy === "path" ? <ArrowClockwise20Regular className="spin" /> : null}{path.state === "elsewhere" ? "Use This Copy" : "Add"}
              </button>
            ) : null}
            {path?.state === "installed" || path?.state === "elsewhere" ? (
              <button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void run("path-remove", () => bridge!.removePath(), `${command} was removed from Terminal.`)}>Remove</button>
            ) : null}
          </div>
        </div>
      </div>
      </section>
      <section className="settings-section" aria-labelledby="command-line-agents">
      <div className="settings-section-heading"><h3 id="command-line-agents">AI Agents</h3></div>
      <div className="settings-list">
        {agents.map(({ target, name }) => {
          const skill = status?.skills[target];
          const label = !skill ? "Checking" : skill.installed === "current" ? "Added" : skill.installed === "outdated" ? "Update available" : !skill.available ? "Not found on this Mac" : "Not added";
          return (
            <div className="settings-list-row" key={target}>
              <div>
                <strong>{name}</strong>
                <small>{skill?.installed === "none" && !skill.available ? `${name} isn't set up on this Mac.` : `Adds the ${command} skill to ${name}'s skills.`}</small>
              </div>
              <div className="settings-actions">
                <span className={`command-line-state${skill?.installed === "current" ? " is-on" : ""}`}>{skill?.installed === "current" ? <Checkmark16Regular aria-hidden="true" /> : null}{label}</span>
                {skill && skill.installed !== "current" && (skill.available || skill.installed === "outdated") ? (
                  <button className="ui-control ui-control--primary" type="button" disabled={Boolean(busy)} onClick={() => void run(target, () => bridge!.installSkill(target), `${name} can use ${product} now.`)}>
                    {busy === target ? <ArrowClockwise20Regular className="spin" /> : null}{skill.installed === "outdated" ? "Update" : "Add"}
                  </button>
                ) : null}
                {skill && skill.installed !== "none" ? (
                  <button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void run(`${target}-remove`, () => bridge!.removeSkill(target), `The ${command} skill was removed from ${name}.`)}>Remove</button>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="settings-list-row">
          <div>
            <strong>Any Other Agent</strong>
            <small>Copy the skill into the agent's skills folder or instructions.</small>
          </div>
          <div className="settings-actions">
            <button className="ui-control" type="button" aria-expanded={skillOpen} onClick={() => setSkillOpen((open) => !open)}>{skillOpen ? "Hide Skill" : "Show Skill"}</button>
            <button className="ui-control" type="button" onClick={() => void copySkill()}>Copy Skill</button>
          </div>
        </div>
      </div>
      {skillOpen ? <pre className="command-line-skill" tabIndex={0} aria-label="The skill file">{outsideAgentSkill()}</pre> : null}
      </section>
    </div>
  );
}
