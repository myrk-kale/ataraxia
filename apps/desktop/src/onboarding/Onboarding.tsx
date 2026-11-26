import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog, Key } from "../ui/Overlay";
import { SLIDES, type Slide } from "./slides";
import { markOnboardingSeen } from "./store";

const SlideScene = lazy(() => import("./scenes"));

/** The animation is a still picture for whoever asks the system for less motion. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function Visual({ slide }: { slide: Slide }) {
  const reduced = useReducedMotion();
  return (
    <Suspense fallback={null}>
      <SlideScene scene={slide.visual.scene} still={reduced} />
    </Suspense>
  );
}

/**
 * The welcome tour: a few short slides, each with an animation, the problem it solves and what to do
 * with it, in a dialog in the middle of the screen with everything else dimmed. It is shown once
 * (the mark is kept when it is closed, finished or skipped), and can be opened again from the
 * keyboard shortcuts.
 */
export function Onboarding({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const slide = SLIDES[index]!;
  const last = index === SLIDES.length - 1;

  // Every opening starts from the first slide.
  useEffect(() => {
    if (isOpen) setIndex(0);
  }, [isOpen]);

  function close() {
    markOnboardingSeen();
    onClose();
  }

  const go = (to: number) => setIndex(Math.min(SLIDES.length - 1, Math.max(0, to)));

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((now) => Math.min(SLIDES.length - 1, now + 1));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((now) => Math.max(0, now - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <Dialog dim className="w-[min(940px,94vw)] max-w-none gap-0 overflow-hidden p-0" dismissable={false} isOpen={isOpen} label="Welcome to Ataraxia" size="lg" onClose={close}>
      <div className="flex max-h-[92vh] flex-col md:h-[min(560px,90vh)] md:flex-row">
        <div className="relative h-[220px] flex-none overflow-hidden border-b border-cg-line bg-cg-tint md:h-auto md:w-[56%] md:border-r md:border-b-0">
          <Visual key={slide.id} slide={slide} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center justify-between px-6 pt-4">
            <span className="text-small font-semibold tracking-wide text-cg-accent uppercase">{slide.eyebrow}</span>
            <Button aria-label="Skip the tour" size="sm" variant="quiet" onClick={close}>
              Skip
              <X aria-hidden="true" size={12} />
            </Button>
          </div>
          <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-3">
            <h2 className="text-heading leading-tight font-semibold text-cg-ink">{slide.title}</h2>
            <p className="mt-1.5 text-ui leading-snug text-cg-muted-strong">{slide.problem}</p>
            <ul className="mt-3.5 flex flex-col gap-2">
              {slide.points.map((point) => (
                <li key={point} className="flex gap-2.5 text-ui leading-snug text-cg-ink">
                  <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-cg-accent" />
                  {point}
                </li>
              ))}
            </ul>
            {slide.keys ? (
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                {slide.keys.map((item) => (
                  <span key={item.label} className="flex items-center gap-1.5 text-small text-cg-muted-strong">
                    <span className="flex items-center gap-1">
                      {item.keys.map((key) => (
                        <Key key={key}>{key}</Key>
                      ))}
                    </span>
                    {item.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <footer className="flex flex-none items-center justify-between gap-3 border-t border-cg-line px-6 py-3.5">
            <div aria-label={`Slide ${index + 1} of ${SLIDES.length}`} className="flex items-center gap-1.5" role="group">
              {SLIDES.map((item, at) => (
                <button
                  key={item.id}
                  aria-current={at === index ? "step" : undefined}
                  aria-label={`Go to ${item.title}`}
                  className="group grid h-4 w-3.5 place-items-center"
                  type="button"
                  onClick={() => go(at)}
                >
                  <span className={`h-1.5 rounded-full transition-all ${at === index ? "w-4 bg-cg-accent" : "w-1.5 bg-cg-control group-hover:bg-cg-muted-strong"}`} />
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button aria-label="Previous slide" disabled={index === 0} variant="quiet" onClick={() => go(index - 1)}>
                <ArrowLeft aria-hidden="true" size={14} />
              </Button>
              {last ? (
                <Button variant="primary" onClick={close}>
                  Start using Ataraxia
                </Button>
              ) : (
                <Button autoFocus variant="primary" onClick={() => go(index + 1)}>
                  Next
                  <ArrowRight aria-hidden="true" size={14} />
                </Button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </Dialog>
  );
}
