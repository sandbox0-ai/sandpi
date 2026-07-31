"use client";

import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./alert-dialog.module.css";

export type AlertDialogTone = "neutral" | "warning" | "danger";

export interface AlertDialogOptions {
  title: string;
  description?: string;
  actionLabel?: string;
  tone?: AlertDialogTone;
}

export interface ConfirmDialogOptions extends AlertDialogOptions {
  cancelLabel?: string;
}

interface AlertDialogContextValue {
  alert: (options: AlertDialogOptions) => Promise<void>;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
}

interface AlertDialogRequest {
  id: number;
  kind: "alert" | "confirm";
  options: ConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
}

const AlertDialogContext = createContext<AlertDialogContextValue | null>(null);

/**
 * Hosts one accessible alert surface for the entire application. Requests are
 * queued so a second alert never replaces a decision that is already open.
 */
export function AlertDialogProvider({ children }: { children: ReactNode }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const currentRequestRef = useRef<AlertDialogRequest | undefined>(undefined);
  const queuedRequestsRef = useRef<AlertDialogRequest[]>([]);
  const [currentRequest, setCurrentRequest] = useState<
    AlertDialogRequest | undefined
  >(undefined);

  const enqueue = useCallback(
    (kind: AlertDialogRequest["kind"], options: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        requestIdRef.current += 1;
        const request: AlertDialogRequest = {
          id: requestIdRef.current,
          kind,
          options,
          resolve,
        };
        if (currentRequestRef.current) {
          queuedRequestsRef.current.push(request);
          return;
        }
        currentRequestRef.current = request;
        setCurrentRequest(request);
      }),
    [],
  );

  const settle = useCallback((requestId: number, confirmed: boolean) => {
    const request = currentRequestRef.current;
    if (!request || request.id !== requestId) return;
    const nextRequest = queuedRequestsRef.current.shift();
    currentRequestRef.current = nextRequest;
    setCurrentRequest(nextRequest);
    request.resolve(confirmed);
  }, []);

  const alert = useCallback(
    async (options: AlertDialogOptions) => {
      await enqueue("alert", options);
    },
    [enqueue],
  );
  const confirm = useCallback(
    (options: ConfirmDialogOptions) => enqueue("confirm", options),
    [enqueue],
  );
  const contextValue = useMemo(
    () => ({ alert, confirm }),
    [alert, confirm],
  );

  useEffect(
    () => () => {
      const pendingRequests = [
        currentRequestRef.current,
        ...queuedRequestsRef.current,
      ];
      currentRequestRef.current = undefined;
      queuedRequestsRef.current = [];
      for (const request of pendingRequests) request?.resolve(false);
    },
    [],
  );

  useEffect(() => {
    if (!currentRequest) return;
    const activeRequest = currentRequest;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferredTarget =
        activeRequest.kind === "confirm"
          ? cancelButtonRef.current
          : actionButtonRef.current;
      (preferredTarget ?? dialogRef.current)?.focus();
    });

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(activeRequest.id, false);
    }

    document.addEventListener("keydown", handleEscape, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [currentRequest, settle]);

  function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const tone = currentRequest?.options.tone ?? "neutral";
  const ToneIcon =
    tone === "danger"
      ? CircleAlert
      : tone === "warning"
        ? TriangleAlert
        : Info;

  return (
    <AlertDialogContext.Provider value={contextValue}>
      {children}
      {currentRequest ? (
        <div
          className={styles.backdrop}
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              settle(currentRequest.id, false);
            }
          }}
        >
          <section
            key={currentRequest.id}
            ref={dialogRef}
            className={`${styles.dialog} ${styles[tone]}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={
              currentRequest.options.description ? descriptionId : undefined
            }
            tabIndex={-1}
            onKeyDown={keepFocusInside}
          >
            <div className={styles.content}>
              <span className={styles.icon} aria-hidden="true">
                <ToneIcon size={19} strokeWidth={1.9} />
              </span>
              <div className={styles.copy}>
                <h2 id={titleId}>{currentRequest.options.title}</h2>
                {currentRequest.options.description ? (
                  <p id={descriptionId}>
                    {currentRequest.options.description}
                  </p>
                ) : null}
              </div>
            </div>
            <footer className={styles.footer}>
              {currentRequest.kind === "confirm" ? (
                <button
                  ref={cancelButtonRef}
                  type="button"
                  className={styles.cancelButton}
                  onClick={() => settle(currentRequest.id, false)}
                >
                  {currentRequest.options.cancelLabel ?? "Cancel"}
                </button>
              ) : null}
              <button
                ref={actionButtonRef}
                type="button"
                className={styles.actionButton}
                onClick={() => settle(currentRequest.id, true)}
              >
                {currentRequest.options.actionLabel ??
                  (currentRequest.kind === "confirm" ? "Continue" : "OK")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </AlertDialogContext.Provider>
  );
}

/** Opens the application alert surface from any client component. */
export function useAlertDialog() {
  const context = useContext(AlertDialogContext);
  if (!context) {
    throw new Error("useAlertDialog must be used within AlertDialogProvider.");
  }
  return context;
}
