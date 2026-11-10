import type { GoalCondition } from "./types";

export interface Evaluation {
  ok: boolean;
  detail: string;
}

/** Extract the first plausible price from page text. */
export function extractPrice(text: string): number | null {
  const withSymbol = text.match(/(?:[$€£¥]|USD|CNY|EUR|GBP)\s?([0-9][0-9.,]*)/i);
  const bare = text.match(/\b([0-9]+(?:[.,][0-9]{2}))\b/);
  const m = withSymbol ?? bare;
  if (!m) return null;
  const num = Number.parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

/** Pure evaluation of a goal condition against observed page text. */
export function evaluateCondition(text: string, condition: GoalCondition): Evaluation {
  switch (condition.type) {
    case "contains": {
      const ok = text.includes(condition.value);
      return { ok, detail: ok ? `found "${condition.value}"` : `"${condition.value}" not present` };
    }
    case "absent": {
      const ok = !text.includes(condition.value);
      return { ok, detail: ok ? `"${condition.value}" is absent` : `"${condition.value}" still present` };
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(condition.value);
      } catch (err) {
        return { ok: false, detail: `invalid regex: ${(err as Error).message}` };
      }
      const m = re.exec(text);
      return { ok: Boolean(m), detail: m ? `matched: ${m[0].slice(0, 80)}` : `no match for /${condition.value}/` };
    }
    case "price_below": {
      const threshold = Number.parseFloat(condition.value);
      if (!Number.isFinite(threshold)) return { ok: false, detail: `invalid threshold: ${condition.value}` };
      const price = extractPrice(text);
      if (price === null) return { ok: false, detail: "no price found on the page" };
      const ok = price < threshold;
      return { ok, detail: `found price ${price}; threshold ${threshold}` };
    }
    default:
      return { ok: false, detail: "unknown condition type" };
  }
}
