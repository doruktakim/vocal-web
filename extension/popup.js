const transcriptField = document.getElementById("transcript");
const apiBaseField = document.getElementById("apiBase");
const outputEl = document.getElementById("output");
const runButton = document.getElementById("run");
const micToggle = document.getElementById("micToggle");

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let isListening = false;
let microphonePermissionGranted = false;

function updateMicButtonLabel(text) {
  if (!SpeechRecognition) {
    micToggle.textContent = "🎙️ Speech unavailable";
    micToggle.disabled = true;
    return;
  }
  if (text) {
    micToggle.textContent = text;
    return;
  }
  micToggle.textContent = isListening
    ? "🔴 Listening... click to stop"
    : "🎙️ Start listening";
}

function ensureRecognition() {
  if (!SpeechRecognition) {
    return null;
  }
  if (recognition) {
    return recognition;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript) {
      transcriptField.value = transcript;
      log(`Heard: ${transcript}`);
      runDemo(transcript);
    }
  };
  recognition.onend = () => {
    isListening = false;
    updateMicButtonLabel();
  };
  recognition.onerror = (event) => {
    log(`Speech recognition error: ${event.error}`);
    isListening = false;
    updateMicButtonLabel();
  };

  return recognition;
}

async function requestMicrophoneAccess() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    log("Microphone access is unavailable in this context.");
    return false;
  }
  if (microphonePermissionGranted) {
    return true;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    microphonePermissionGranted = true;
    return true;
  } catch (err) {
    log(`Microphone access denied: ${err.message || err}`);
    return false;
  }
}

async function toggleListening() {
  if (!SpeechRecognition) {
    log("Speech recognition is not supported in this browser.");
    return;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) {
    log("Unable to access speech recognition.");
    return;
  }
  if (isListening) {
    recognizer.stop();
    isListening = false;
    updateMicButtonLabel("Stopping...");
    return;
  }
  const granted = await requestMicrophoneAccess();
  if (!granted) {
    updateMicButtonLabel();
    return;
  }
  try {
    isListening = true;
    updateMicButtonLabel();
    recognizer.start();
    log("Listening...");
  } catch (err) {
    log(`Failed to start speech recognition: ${err.message || err}`);
    isListening = false;
    updateMicButtonLabel();
  }
}

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

function runDemo(transcriptInput) {
  const transcript = (transcriptInput || transcriptField.value).trim();
  if (!transcript) {
    log("Please provide a transcript before running the demo.");
    return;
  }
  const apiBase = apiBaseField.value.trim();
  console.log("Status: Requesting action plan...");
  chrome.runtime.sendMessage({ type: "vcaa-set-api", apiBase });
  chrome.runtime.sendMessage({ type: "vcaa-run-demo", transcript }, (resp) => {
    log(formatResponse(resp));
    if (!resp) {
      console.log("Status: No response from extension");
      return;
    }
    if (resp.status === "error") {
      console.log("Status: Last run failed");
      return;
    }
    if (resp.status === "needs_clarification") {
      console.log("Status: Awaiting clarification");
      return;
    }
    console.log("Status: Completed successfully");
  });
}

runButton.addEventListener("click", () => {
  runDemo();
});

if (micToggle) {
  micToggle.addEventListener("click", toggleListening);
}

updateMicButtonLabel();
loadConfig();
