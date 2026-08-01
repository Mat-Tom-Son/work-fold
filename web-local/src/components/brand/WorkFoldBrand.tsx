import { productName } from "../../constants";

export function WorkFoldMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={["work-fold-mark", className].filter(Boolean).join(" ")}
      viewBox="142 142 740 740"
      aria-hidden="true"
      focusable="false"
    >
      <path className="work-fold-mark-plane work-fold-mark-plane-left" d="M184 300h142l90 336 96-188 96 188 90-336h142L664 780H552l-40-86-40 86H360L184 300Z" />
      <path className="work-fold-mark-plane work-fold-mark-plane-right" d="m512 448 96 188 90-336h142L664 780H552l-40-86V448Z" />
      <path className="work-fold-mark-crease" d="m512 448 36 71-36 175-27-58 27-188Z" />
    </svg>
  );
}

export function WorkFoldLockup({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  return (
    <div
      className={["work-fold-lockup", className].filter(Boolean).join(" ")}
      data-animated={animated ? "true" : undefined}
      aria-label={productName}
    >
      <span className="work-fold-mark-shell" aria-hidden="true"><WorkFoldMark /></span>
      <span className="work-fold-wordmark" aria-hidden="true">{productName}</span>
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
