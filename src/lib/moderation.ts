/**
 * Prompt moderation.
 *
 * A word list, honestly labelled. It catches the obvious and it is trivially
 * bypassed by anyone determined, because that is what a static list is. It
 * exists to stop an accidental bad request and to keep the worst output out of
 * the gallery, not to be a compliance control.
 *
 * Swapping in a real classifier means replacing `moderate()` and nothing else:
 * the interface is one function returning a verdict.
 */

export type Severity = "block" | "warn";

export interface ModerationVerdict {
  allowed: boolean;
  severity: Severity | null;
  reason: string | null;
  /** Which category matched, for logging. Never shown to the user verbatim. */
  category: string | null;
}

/**
 * Categories are deliberately coarse. Naming the specific category to a user
 * tells an abuser exactly which word to swap for a synonym.
 */
const RULES: Array<{ category: string; severity: Severity; patterns: RegExp }> = [
  {
    category: "csam",
    severity: "block",
    // Matched on compressed/underscored variants too, since those are the
    // common evasions and a plain substring check misses all of them.
    patterns:
      /\b(child|minor|underage|teen|kid|schoolgirl|schoolboy|child(?:hood)?)\b[\s._-]*(nude|naked|explicit|sex|porn|erotic|lingerie)/i,
  },
  {
    category: "csam",
    severity: "block",
    patterns: /\b(?:loli|shota|childporn|child[-_ ]?porn)\b/i,
  },
  {
    category: "sexual_non_consensual",
    severity: "block",
    patterns: /\b(rape|raping|molest(?:ing|ation)|incest)\b/i,
  },
  {
    category: "weapons_mass_harm",
    severity: "block",
    // IED / V2 / "pipe bomb" style constructions, plus explicit synthesis verbs.
    patterns:
      /\b(ied|v2\s*ied|pipe\s*bomb|pressure\s*cooker\s*bomb|car\s*bomb|suicide\s*vest)\b[\s\S]{0,40}\b(make|making|build|building|how\s*to|instructions|synthesis|construct)\b/i,
  },
  {
    category: "weapons_mass_harm",
    severity: "block",
    patterns: /\b(how\s*to\s*(make|build|synthesi[sz]e)|instructions\s*for\s*(making|building))\b[\s\S]{0,40}\b(bomb|explosive|nerve\s*agent|sarin|ricin|anthrax|weapon)\b/i,
  },
  {
    category: "real_person_deepfake",
    severity: "warn",
    // Allowed but flagged: a real person's likeness is a consent question the
    // app cannot settle on the user's behalf.
    patterns: /\b(deepfake|face\s*swap|impersonat\w+)\b/i,
  },
  {
    category: "public_figure",
    severity: "warn",
    patterns: /\b(as\s+(a|an)\s+(?:real|actual)\s+(?:person|celebrity)|real\s+person)\b/i,
  },
];

export function moderate(prompt: string): ModerationVerdict {
  const text = prompt.trim();
  if (!text) {
    return { allowed: false, severity: "block", reason: "Prompt is empty.", category: null };
  }

  for (const rule of RULES) {
    if (rule.patterns.test(text)) {
      if (rule.severity === "block") {
        return {
          allowed: false,
          severity: "block",
          reason:
            "This prompt was blocked by the content filter. If you believe this is a mistake, rephrase it.",
          category: rule.category,
        };
      }
      // Warn: allowed, but the caller may surface a notice.
      return {
        allowed: true,
        severity: "warn",
        reason:
          rule.category === "real_person_deepfake"
            ? "Generating realistic video of a real person may require their consent."
            : null,
        category: rule.category,
      };
    }
  }

  return { allowed: true, severity: null, reason: null, category: null };
}

/** Rejection reasons that leak implementation detail are replaced with this. */
export function publicReason(verdict: ModerationVerdict): string | null {
  return verdict.allowed ? null : (verdict.reason ?? "That prompt was blocked.");
}