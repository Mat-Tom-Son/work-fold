import { productName } from "../../constants";
import lockupBlackUrl from "../../assets/brand/work-fold-lockup-black.png";
import lockupWhiteUrl from "../../assets/brand/work-fold-lockup-white.png";
import markUrl from "../../assets/brand/work-fold-mark.png";

export function WorkFoldMark({ className = "" }: { className?: string }) {
  return (
    <img
      className={["work-fold-mark", className].filter(Boolean).join(" ")}
      src={markUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function WorkFoldLockup({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  // The provided horizontal lockups are single images: black carries light
  // themes, white carries dark themes.
  return (
    <div
      className={["work-fold-lockup", className].filter(Boolean).join(" ")}
      data-animated={animated ? "true" : undefined}
      role="img"
      aria-label={productName}
    >
      <img className="work-fold-lockup-art work-fold-lockup-art-black" src={lockupBlackUrl} alt="" draggable={false} />
      <img className="work-fold-lockup-art work-fold-lockup-art-white" src={lockupWhiteUrl} alt="" draggable={false} />
    </div>
  );
}

export function WorkFoldLoadingState({ message }: { message: string }) {
  return (
    <div className="work-fold-loading-state" role="status" aria-live="polite">
      <WorkFoldLockup className="work-fold-loading-lockup" animated />
      <p>{message}</p>
    </div>
  );
}
