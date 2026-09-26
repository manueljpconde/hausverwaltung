"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Spielt Hintergrundvideos stumm ab. Mehrere Quellen → zufällige Reihenfolge,
 * nacheinander in Endlosschleife. Eine Quelle → einfacher Loop.
 * Optional (#33): Standbild (poster), Pause-/Play-Schaltfläche (controls, WCAG 2.2.2)
 * und mediaQuery — das Video wird dann nur im Browser eingebunden, wenn die Abfrage
 * zutrifft (kein Download auf dem Telefon oder bei reduzierter Bewegung).
 */
export function BackgroundVideo({
  sources,
  className,
  poster,
  controls = false,
  pauseLabel = "Pause",
  playLabel = "Play",
  controlsClassName,
  mediaQuery,
}: {
  sources: string[];
  className?: string;
  poster?: string;
  controls?: boolean;
  pauseLabel?: string;
  playLabel?: string;
  controlsClassName?: string;
  mediaQuery?: string;
}) {
  // einmalige zufällige Reihenfolge pro Mount
  const order = useMemo(() => [...sources].sort(() => Math.random() - 0.5), [sources]);
  const [i, setI] = useState(0);
  // Zustand kommt aus den Video-Ereignissen (Autoplay kann blockiert sein).
  const [paused, setPaused] = useState(true);
  const [allowed, setAllowed] = useState(!mediaQuery);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!mediaQuery) return;
    const mq = window.matchMedia(mediaQuery);
    const update = () => setAllowed(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [mediaQuery]);

  if (order.length === 0 || !allowed) return null;
  const single = order.length === 1;

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  return (
    <>
      <video
        ref={ref}
        key={order[i]}
        className={cn("size-full object-cover", className)}
        autoPlay
        muted
        playsInline
        poster={poster}
        loop={single}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => {
          if (!single) setI((x) => (x + 1) % order.length);
        }}
      >
        <source src={order[i]} />
      </video>
      {controls && (
        <button type="button" onClick={toggle} aria-pressed={paused} className={controlsClassName}>
          {paused ? playLabel : pauseLabel}
        </button>
      )}
    </>
  );
}
