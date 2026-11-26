"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveVideoPositionAction } from "@/features/video-positions/actions";
import { markLessonCompleteAction } from "@/features/progress/actions";
import { AUTO_COMPLETE_FRACTION } from "@/features/video-positions/types";

// ============================================================================
// LESSON VIDEO PLAYER (learner polish: resume + 90% auto-complete)
// ----------------------------------------------------------------------------
// YouTube IFrame Player API wrapper. Remembers the learner's position (saved
// at most every 15 s while playing, plus on pause/ended/pagehide — one write
// per save, upserted server-side) and offers "Resume from M:SS" on load.
// When the watched position reaches 90% of the duration the lesson is marked
// complete through the existing completion path (quiz gates, drip and
// sequential locks still apply); the manual Complete button stays.
// ============================================================================

interface YTPlayer {
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  destroy: () => void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YTPlayer }) => void;
        onStateChange?: (event: { data: number; target: YTPlayer }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_SCRIPT_SRC = "https://www.youtube.com/iframe_api";
// YT.PlayerState numeric values (kept local so no player import is needed).
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ENDED = 0;

let apiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise<YTNamespace>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT?.Player) resolve(window.YT);
        else reject(new Error("YouTube player failed to load"));
      };
      const tag = document.createElement("script");
      tag.src = YT_SCRIPT_SRC;
      tag.async = true;
      tag.onerror = () => {
        apiPromise = null;
        reject(new Error("YouTube player failed to load"));
      };
      document.head.appendChild(tag);
      // Never hang: a blocked script must not stall the lesson forever.
      setTimeout(() => reject(new Error("YouTube player timed out")), 15_000);
    }).catch((error: unknown) => {
      apiPromise = null;
      throw error;
    });
  }
  return apiPromise;
}

export function formatResumeTime(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Positions under this are treated as "not started" (no resume offered). */
const RESUME_MINIMUM_SECONDS = 5;

export function shouldOfferResume(positionSeconds: number | null, durationSeconds: number | null): boolean {
  if (positionSeconds == null || positionSeconds < RESUME_MINIMUM_SECONDS) return false;
  if (durationSeconds != null && durationSeconds > 0 && positionSeconds >= durationSeconds) return false;
  return true;
}

export function LessonVideoPlayer({
  videoId,
  title,
  courseSlug,
  lessonSlug,
  enrollmentId,
  lessonId,
  initialPositionSeconds,
  initialDurationSeconds,
  alreadyDone,
}: {
  videoId: string;
  title: string;
  courseSlug: string;
  lessonSlug: string;
  enrollmentId: string;
  lessonId: string;
  initialPositionSeconds: number | null;
  initialDurationSeconds: number | null;
  alreadyDone: boolean;
}) {
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const lastSaveRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const autoCompleteFiredRef = useRef(alreadyDone);
  const [offerResume, setOfferResume] = useState(() =>
    shouldOfferResume(initialPositionSeconds, initialDurationSeconds),
  );
  // When the IFrame API cannot load (blocked script, timeout), fall back to
  // the plain privacy-enhanced iframe so the video stays playable; position
  // tracking is best-effort only.
  const [apiFailed, setApiFailed] = useState(false);

  useEffect(() => {
    autoCompleteFiredRef.current = alreadyDone;
  }, [alreadyDone]);

  useEffect(() => {
    let cancelled = false;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const save = async (force: boolean) => {
      const player = playerRef.current;
      if (!player || saveInFlightRef.current) return;
      const now = Date.now();
      // At most every 15 s while playing; pause/ended/pagehide always save.
      if (!force && now - lastSaveRef.current < 15_000) return;
      lastSaveRef.current = now;
      let position = 0;
      let duration = 0;
      try {
        position = player.getCurrentTime() ?? 0;
        duration = player.getDuration() ?? 0;
      } catch {
        return;
      }
      if (!Number.isFinite(position) || position < 0) return;
      saveInFlightRef.current = true;
      try {
        await saveVideoPositionAction({
          courseSlug,
          lessonSlug,
          positionSeconds: position,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
        });
      } catch {
        // Best-effort: a failed save must never interrupt playback.
      } finally {
        saveInFlightRef.current = false;
      }
      // 90% auto-complete through the existing completion path (quiz gates,
      // drip and sequential locks still apply server-side). One attempt per
      // page load; the manual Complete button stays for everything else, and
      // the refresh flips it to Completed + Continue on success.
      if (
        !cancelled &&
        !autoCompleteFiredRef.current &&
        Number.isFinite(duration) &&
        duration > 0 &&
        position >= duration * AUTO_COMPLETE_FRACTION
      ) {
        autoCompleteFiredRef.current = true;
        try {
          const res = await markLessonCompleteAction(enrollmentId, lessonId);
          if (!cancelled && res.ok) {
            router.refresh();
          }
        } catch {
          // A refused completion (e.g. quiz gate) stays on the manual button.
        }
      }
    };

    const onPageHide = () => {
      void save(true);
    };

    loadYouTubeApi()
      .then((yt) => {
        if (cancelled || !mountRef.current) return;
        playerRef.current = new yt.Player(mountRef.current, {
          videoId,
          playerVars: { rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              if (cancelled) return;
              const duration = Number(playerRef.current?.getDuration() ?? 0);
              const known = Number.isFinite(duration) && duration > 0 ? duration : initialDurationSeconds;
              setOfferResume((current) => current && shouldOfferResume(initialPositionSeconds, known));
            },
            onStateChange: (event) => {
              if (event.data === YT_PLAYING) {
                if (!ticker) {
                  ticker = setInterval(() => {
                    void save(false);
                  }, 15_000);
                }
              } else {
                if (ticker) {
                  clearInterval(ticker);
                  ticker = null;
                }
                if (event.data === YT_PAUSED || event.data === YT_ENDED) {
                  void save(true);
                }
              }
            },
          },
        });
        window.addEventListener("pagehide", onPageHide);
      })
      .catch(() => {
        if (!cancelled) setApiFailed(true);
      });

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      if (ticker) clearInterval(ticker);
      try {
        playerRef.current?.destroy();
      } catch {
        // Ignore teardown races.
      }
      playerRef.current = null;
    };
    // One player per lesson mount; slugs/ids identify the save target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, courseSlug, lessonSlug, enrollmentId, lessonId]);

  const resume = () => {
    const player = playerRef.current;
    if (!player || initialPositionSeconds == null) return;
    try {
      player.seekTo(initialPositionSeconds, true);
      player.playVideo();
    } catch {
      // Seeking is best-effort; the player remains usable.
    }
    setOfferResume(false);
  };

  if (apiFailed) {
    return (
      <div className="lesson-video">
        <iframe
          className="lesson-video-frame"
          src={`https://www.youtube-nocookie.com/embed/${videoId}`}
          title={`${title} — video`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <div className="lesson-video-stack">
      {offerResume && initialPositionSeconds != null && (
        <div className="learner-mt-12">
          <button type="button" className="btn secondary" onClick={resume}>
            Resume from {formatResumeTime(initialPositionSeconds)}
          </button>
        </div>
      )}
      <div className="lesson-video">
        <div ref={mountRef} className="lesson-video-frame" role="region" aria-label={`${title} — video`} />
      </div>
    </div>
  );
}
