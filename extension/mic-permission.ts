(() => {
  const button = document.getElementById("requestMic") as HTMLButtonElement | null;
  const statusEl = document.getElementById("permissionStatus") as HTMLElement | null;

  const setStatus = (text: string, isError = false): void => {
    if (!statusEl) {
      return;
    }
    const message = text.trim();
    statusEl.textContent = message;
    statusEl.hidden = message.length === 0;
    statusEl.style.color = isError ? "var(--color-danger)" : "";
  };

  const notifyOpener = (granted: boolean): void => {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { type: "vocal-mic-permission", granted },
        window.location.origin
      );
    }
  };

  const requestMicrophone = async (): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Microphone APIs are not supported in this context.", true);
      notifyOpener(false);
      return;
    }

    try {
      setStatus("Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setStatus("Microphone access granted. You can close this window.");
      notifyOpener(true);
      window.setTimeout(() => window.close(), 600);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Microphone access failed: ${message}`, true);
      notifyOpener(false);
    }
  };

  if (button) {
    button.addEventListener("click", () => {
      void requestMicrophone();
    });
  }
})();
