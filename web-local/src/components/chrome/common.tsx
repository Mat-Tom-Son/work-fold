import type React from "react";
import { ChatAdd20Filled, ChatAdd20Regular, bundleIcon, type FluentIcon } from "@fluentui/react-icons";
import { AlertTriangle, X } from "lucide-react";
import type { SpaceIconOption } from "../../space-icons";

const NewChatIcon = bundleIcon(ChatAdd20Filled, ChatAdd20Regular);

function FluentGlyph({
  icon: Icon,
  size,
  filled = true,
  className,
}: {
  icon: FluentIcon;
  size: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <Icon
      className={["fluent-ui-icon", className ?? ""].filter(Boolean).join(" ")}
      style={{ fontSize: `${size}px` }}
      filled={filled}
      aria-hidden="true"
    />
  );
}

function SpaceIconGlyph({
  icon,
  size,
  filled = true,
  className,
}: {
  icon: SpaceIconOption["Icon"];
  size: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <FluentGlyph
      icon={icon}
      size={size}
      filled={filled}
      className={["space-fluent-icon", className ?? ""].filter(Boolean).join(" ")}
    />
  );
}

function PanelTitle({ icon, title, action }: { icon?: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <div className="panel-title">
      <h2>{icon}{title}</h2>
      {action}
    </div>
  );
}

function Banner({ tone, text, onDismiss }: { tone: "error" | "info"; text: string; onDismiss?: () => void }) {
  return (
    <div className={`banner ${tone}`}>
      <AlertTriangle size={16} />
      <span>{text}</span>
      {onDismiss ? (
        <button className="banner-dismiss" type="button" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

function EmptyInline({ text }: { text: string }) {
  return <div className="empty-inline">{text}</div>;
}

function CenteredState({ icon, title, text }: { icon?: React.ReactNode; title: string; text?: string }) {
  return (
    <div className="centered-state">
      {icon ? <div className="centered-icon">{icon}</div> : null}
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

export { Banner, CenteredState, EmptyInline, FluentGlyph, NewChatIcon, PanelTitle, SpaceIconGlyph };
