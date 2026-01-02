(() => {
  type AssistantState =
    | "idle"
    | "listening"
    | "thinking"
    | "planning"
    | "executing"
    | "speaking";

  type StateProfile = {
    label: string;
    baseIntensity: number;
    speed: number;
    hue: number;
    micGain: number;
  };

  const statusEl = document.getElementById("statusText") as HTMLElement | null;
  const canvas = document.getElementById("voiceCanvas") as HTMLCanvasElement | null;
  const manualInput = document.getElementById("manualInput") as HTMLInputElement | null;

  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const stateProfiles: Record<AssistantState, StateProfile> = {
    idle: {
      label: "Idle...",
      baseIntensity: 0.08,
      speed: 0.55,
      hue: 24,
      micGain: 0.6
    },
    listening: {
      label: "Listening...",
      baseIntensity: 0.18,
      speed: 0.9,
      hue: 28,
      micGain: 1.4
    },
    thinking: {
      label: "Thinking...",
      baseIntensity: 0.12,
      speed: 0.7,
      hue: 20,
      micGain: 0.9
    },
    planning: {
      label: "Creating action plan...",
      baseIntensity: 0.14,
      speed: 0.65,
      hue: 16,
      micGain: 0.8
    },
    executing: {
      label: "Executing...",
      baseIntensity: 0.2,
      speed: 1.05,
      hue: 32,
      micGain: 1.1
    },
    speaking: {
      label: "Speaking...",
      baseIntensity: 0.22,
      speed: 1.1,
      hue: 34,
      micGain: 1.3
    }
  };

  const states: AssistantState[] = [
    "idle",
    "listening",
    "thinking",
    "planning",
    "executing",
    "speaking"
  ];

  const stateTimings: Record<AssistantState, number> = {
    idle: 3200,
    listening: 4800,
    thinking: 3400,
    planning: 4200,
    executing: 4200,
    speaking: 3000
  };

  let currentState: AssistantState = "idle";
  let stateIndex = 0;

  const setState = (state: AssistantState): void => {
    currentState = state;
    document.body.dataset.state = state;
    if (statusEl) {
      statusEl.textContent = stateProfiles[state].label;
    }
  };

  const scheduleNextState = (): void => {
    const delay = stateTimings[states[stateIndex]];
    window.setTimeout(() => {
      stateIndex = (stateIndex + 1) % states.length;
      setState(states[stateIndex]);
      scheduleNextState();
    }, delay);
  };

  let baseRadius = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;

  const resizeCanvas = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    baseRadius = Math.min(canvasWidth, canvasHeight) * 0.28;
  };

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array<ArrayBuffer> | null = null;
  let micLevel = 0;

  const initMic = async (): Promise<void> => {
    if (audioContext) {
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      dataArray = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch (error) {
      audioContext = null;
      analyser = null;
      dataArray = null;
    }
  };

  const readMicLevel = (): number => {
    if (!analyser || !dataArray) {
      return 0;
    }
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i += 1) {
      const value = (dataArray[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    return Math.min(1, rms * 1.8);
  };

  const lerp = (start: number, end: number, amount: number): number =>
    start + (end - start) * amount;

  const drawBlob = (time: number): void => {
    const profile = stateProfiles[currentState];
    const nextMic = readMicLevel();
    micLevel = lerp(micLevel, nextMic, 0.08);

    const intensity = profile.baseIntensity + micLevel * profile.micGain;
    const t = time * 0.001 * profile.speed;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const points = 140;

    ctx.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const angle = (i / points) * Math.PI * 2;
      const wobble =
        Math.sin(angle * 3 + t * 1.4) * 0.5 +
        Math.sin(angle * 5 - t * 0.9) * 0.3 +
        Math.sin(angle * 2 + t * 0.4) * 0.2;
      const radius = baseRadius * (1 + wobble * (0.12 + intensity * 0.35));
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();

    const gradient = ctx.createRadialGradient(
      centerX,
      centerY,
      baseRadius * 0.2,
      centerX,
      centerY,
      baseRadius * 1.35
    );
    gradient.addColorStop(0, `hsla(${profile.hue}, 55%, 72%, ${0.35 + intensity * 0.2})`);
    gradient.addColorStop(1, `hsla(${profile.hue}, 40%, 58%, 0.08)`);

    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.lineWidth = 1.2 + intensity * 1.2;
    ctx.strokeStyle = `hsla(${profile.hue}, 50%, 45%, ${0.28 + intensity * 0.2})`;
    ctx.shadowColor = `hsla(${profile.hue}, 55%, 60%, ${0.2 + intensity * 0.3})`;
    ctx.shadowBlur = 18 + intensity * 28;
    ctx.stroke();
  };

  const animate = (time: number): void => {
    drawBlob(time);
    requestAnimationFrame(animate);
  };

  const enableInputShortcut = (): void => {
    if (!manualInput) {
      return;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && document.activeElement !== manualInput) {
        event.preventDefault();
        manualInput.focus();
      }
    });
  };

  document.addEventListener("pointerdown", () => {
    void initMic();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void initMic();
    }
  });

  setState(currentState);
  scheduleNextState();
  enableInputShortcut();
  void initMic();
  requestAnimationFrame(animate);
})();
