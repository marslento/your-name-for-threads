import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { t } from "../i18n/t";
import { THREADS_HOME_URL } from "../shared/threadsUrl";
import { setOnboardingCompleted } from "./onboardingState";

const STEPS = ["onboarding_step1", "onboarding_step2", "onboarding_step3"] as const;

export interface OnboardingFlowProps {
  /** Called once the last step's action has run, so the host can put the tour away. */
  onDone: () => void;
}

/**
 * The three-step first-run tour (Phase 4 §10). Shared by the popup (first
 * open) and the About page (replay), so the last step does the real work
 * itself - records completion, opens Threads - instead of leaving it to each
 * host. Only that last action completes it: closing the popup midway leaves
 * the tour to show again, which is harmless.
 */
export function OnboardingFlow({ onDone }: OnboardingFlowProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  // Focus follows the step so keyboard and screen-reader users land on what
  // changed. Keyed on the step actually changing rather than on "not the
  // first run", so StrictMode's replayed mount effect cannot steal focus.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  async function openThreads() {
    if (busy) return;
    setBusy(true);
    try {
      // Neither failure may keep the user from finishing: a lost flag only
      // means the tour shows once more, and they can open Threads themselves.
      await setOnboardingCompleted(true);
    } catch {
      // see above
    }
    try {
      await chrome.tabs.create({ url: THREADS_HOME_URL });
    } catch {
      // see above
    }
    setBusy(false);
    onDone();
  }

  const key = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <section aria-labelledby="onboarding-title" className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t("onboarding_stepProgress", [String(step + 1), String(STEPS.length)])}
      </p>
      <h2
        id="onboarding-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold tracking-tight outline-none"
      >
        {t(`${key}_title`)}
      </h2>
      <p className="text-sm leading-6 text-muted-foreground">{t(`${key}_body`)}</p>
      <div className="flex items-center justify-between gap-2 pt-1">
        {step > 0 ? (
          <Button variant="outline" onClick={() => setStep(step - 1)}>
            {t("onboarding_back")}
          </Button>
        ) : (
          <span />
        )}
        {last ? (
          <Button disabled={busy} onClick={() => void openThreads()}>
            {t("onboarding_openThreads")}
          </Button>
        ) : (
          <Button onClick={() => setStep(step + 1)}>{t("onboarding_next")}</Button>
        )}
      </div>
    </section>
  );
}
