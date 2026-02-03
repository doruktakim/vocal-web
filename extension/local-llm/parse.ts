(() => {
  const namespace = (window.VocalWebLocalLLM = window.VocalWebLocalLLM || {});

  const collectBalancedJsonObjects = (text: string): string[] => {
    const source = String(text || "").trim();
    if (!source) {
      return [];
    }

    const results: string[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") {
        if (depth === 0) {
          start = i;
        }
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          results.push(source.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return results;
  };

  const extractJsonObject = (text: string): string | null => {
    const source = String(text || "").trim();
    if (!source) {
      return null;
    }

    const candidateBlocks: string[] = [];
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null = null;
    while ((match = fencedRegex.exec(source))) {
      if (match[1]) {
        candidateBlocks.push(match[1].trim());
      }
    }
    candidateBlocks.push(source);

    for (const block of candidateBlocks) {
      const objects = collectBalancedJsonObjects(block);
      for (const candidate of objects) {
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (isPlanSchema(parsed)) {
            return candidate;
          }
        } catch {
          // keep scanning; local models often emit partial/extra JSON snippets
        }
      }
    }

    return null;
  };

  const isPlanSchema = (value: unknown): value is ActionPlan | ClarificationRequest => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const schema = String((value as { schema_version?: string }).schema_version || "");
    return schema === "actionplan_v1" || schema === "clarification_v1";
  };

  const parseInterpreterJson = (text: string): ActionPlan | ClarificationRequest | null => {
    const jsonText = extractJsonObject(text);
    if (!jsonText) {
      return null;
    }
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!isPlanSchema(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  namespace.extractJsonObject = extractJsonObject;
  namespace.parseInterpreterJson = parseInterpreterJson;
})();
