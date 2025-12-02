const transcriptField = document.getElementById("transcript");
const apiBaseField = document.getElementById("apiBase");
const outputEl = document.getElementById("output");
const runButton = document.getElementById("run");

function log(msg) {
  outputEl.textContent = msg;
}

function formatClarification(plan) {
  if (!plan) {
    return "Needs clarification, but no plan was provided.";
  }
  const lines = [];
  if (plan.question) {
    lines.push(`Question: ${plan.question}`);
  } else {
    lines.push("Question: clarification requested.");
  }

  if (plan.options?.length) {
    lines.push("Options:");
    plan.options.forEach((option, idx) => {
      const candidateInfo = option.candidate_element_ids?.length
        ? ` (elements: ${option.candidate_element_ids.join(", ")})`
        : "";
      lines.push(`${idx + 1}. ${option.label}${candidateInfo}`);
    });
  }

  if (plan.reason) {
    lines.push(`Reason: ${plan.reason}`);
  }
  return lines.join("\n");
}

function formatResponse(resp) {
  if (!resp) {
    return "No response received.";
  }

  if (resp.status === "error") {
    return resp.error || "An unknown error occurred.";
  }

  if (resp.status === "needs_clarification") {
    const plan = resp.actionPlan || resp.executionPlan;
    return formatClarification(plan);
  }

  if (resp.status === "completed") {
    const lines = [];
    if (resp.actionPlan) {
      const action = resp.actionPlan.action || "unknown action";
      const target = resp.actionPlan.target || "unknown target";
      lines.push(`Action plan: ${action} → ${target}`);
    }
    if (resp.executionPlan?.steps?.length) {
      lines.push("Execution steps:");
      resp.executionPlan.steps.forEach((step) => {
        const valuePart = step.value ? ` = "${step.value}"` : "";
        lines.push(
          `  • ${step.action_type} ${step.element_id || "(unknown element)"}${valuePart}`
        );
      });
    }
    if (resp.execResult) {
      lines.push(`Execution result: ${resp.execResult.status || "unknown status"}`);
    }
    return lines.join("\n") || "Completed with no additional details.";
  }

  return JSON.stringify(resp, null, 2);
}

function loadConfig() {
  chrome.storage.sync.get(["vcaaApiBase"], (result) => {
    if (result.vcaaApiBase) {
      apiBaseField.value = result.vcaaApiBase;
    } else {
      apiBaseField.value = "http://localhost:8081";
    }
  });
}

runButton.addEventListener("click", () => {
  const transcript = transcriptField.value.trim();
  const apiBase = apiBaseField.value.trim();
  chrome.runtime.sendMessage({ type: "vcaa-set-api", apiBase });
  chrome.runtime.sendMessage({ type: "vcaa-run-demo", transcript }, (resp) => {
    log(formatResponse(resp));
  });
});

loadConfig();
