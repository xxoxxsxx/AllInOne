"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ToastTone = "success" | "error";

type ToastItem = {
  duration: number;
  id: number;
  leaving: boolean;
  text: string;
  tone: ToastTone;
};

type ToastEventDetail = {
  duration?: number;
  text: string;
  tone?: ToastTone;
};

const TOAST_EVENT = "app-toast";

const SUCCESS_DURATION = 3000;
const ERROR_DURATION = 8000;
const LEAVE_DURATION = 200;
const MAX_VISIBLE = 3;

export function showToast(
  text: string,
  options?: {
    duration?: number;
    tone?: ToastTone;
  },
) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<ToastEventDetail>(TOAST_EVENT, {
      detail: {
        duration: options?.duration,
        text,
        tone: options?.tone,
      },
    }),
  );
}

function getDuration(tone: ToastTone) {
  return tone === "error" ? ERROR_DURATION : SUCCESS_DURATION;
}

export function ToastHost() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const nextIdRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));

    const timer = timersRef.current.get(id);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const beginLeave = useCallback(
    (id: number) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, leaving: true } : item,
        ),
      );

      const timer = window.setTimeout(() => remove(id), LEAVE_DURATION);
      timersRef.current.set(id, timer);
    },
    [remove],
  );

  const push = useCallback(
    (text: string, tone: ToastTone, duration: number) => {
      const id = nextIdRef.current + 1;
      nextIdRef.current = id;

      setItems((prev) =>
        [
          ...prev,
          { duration, id, leaving: false, text, tone },
        ].slice(-MAX_VISIBLE),
      );

      const timer = window.setTimeout(() => beginLeave(id), duration);
      timersRef.current.set(id, timer);
    },
    [beginLeave],
  );

  useEffect(() => {
    function handleToast(event: Event) {
      const detail = (event as CustomEvent<ToastEventDetail>).detail;

      if (!detail || !detail.text) {
        return;
      }

      const tone = detail.tone ?? "success";
      push(detail.text, tone, detail.duration ?? getDuration(tone));
    }

    window.addEventListener(TOAST_EVENT, handleToast);

    return () => window.removeEventListener(TOAST_EVENT, handleToast);
  }, [push]);

  useEffect(() => {
    const message = searchParams.get("message");
    const error = searchParams.get("error");

    if (!message && !error) {
      return;
    }

    if (message) {
      push(message, "success", getDuration("success"));
    }

    if (error) {
      push(error, "error", getDuration("error"));
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete("message");
    next.delete("error");
    const query = next.toString();

    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [pathname, push, router, searchParams]);

  useEffect(() => {
    const timers = timersRef.current;

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto relative flex w-full max-w-md items-start gap-3 overflow-hidden rounded-2xl border px-4 py-3 shadow-[0_16px_48px_rgba(15,23,42,0.18)] ${
            item.tone === "error"
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          } ${item.leaving ? "animate-toast-out" : "animate-toast-in"}`}
        >
          {item.tone === "error" ? (
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              fill="currentColor"
              className="mt-0.5 h-5 w-5 shrink-0"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.5a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0v-4ZM10 13a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              fill="currentColor"
              className="mt-0.5 h-5 w-5 shrink-0"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.707-9.293a1 1 0 0 0-1.414-1.414L9 10.586 7.707 9.293a1 1 0 0 0-1.414 1.414l2 2a1 1 0 0 0 1.414 0l4-4Z"
                clipRule="evenodd"
              />
            </svg>
          )}

          <p className="flex-1 break-words text-sm leading-6">{item.text}</p>

          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => beginLeave(item.id)}
            className="shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
          >
            <svg
              aria-hidden
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className="h-3.5 w-3.5"
            >
              <path d="M2 2l10 10M12 2 2 12" strokeLinecap="round" />
            </svg>
          </button>

          <span
            aria-hidden
            className={`absolute inset-x-0 bottom-0 h-0.5 ${
              item.tone === "error" ? "bg-rose-400/70" : "bg-emerald-500/70"
            }`}
            style={{
              animation: `toast-progress ${item.duration}ms linear forwards`,
            }}
          />
        </div>
      ))}
    </div>
  );
}
