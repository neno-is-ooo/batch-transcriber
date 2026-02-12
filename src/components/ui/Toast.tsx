import { useEffect } from "react";

export type ToastTone = "info" | "success" | "warning";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  message: string;
  tone?: ToastTone;
  duration?: number;
  action?: ToastAction;
  onDismiss?: () => void;
}

export function Toast({
  message,
  tone = "info",
  duration = 3_000,
  action,
  onDismiss,
}: ToastProps) {
  useEffect(() => {
    if (!onDismiss || duration <= 0) {
      return;
    }

    const timer = setTimeout(() => {
      onDismiss();
    }, duration);

    return () => {
      clearTimeout(timer);
    };
  }, [duration, onDismiss]);

  return (
    <div
      className={`toast toast--${tone}`}
      role="status"
      aria-live="polite"
      data-testid="toast"
    >
      <span>{message}</span>
      {action ? (
        <button type="button" className="toast__action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
