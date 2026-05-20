export interface SessionWireRelayGate {
  isPaused(): boolean;
  pause(): () => void;
}

export function createSessionWireRelayGate(): SessionWireRelayGate {
  let pauseDepth = 0;

  return {
    isPaused() {
      return pauseDepth > 0;
    },
    pause() {
      pauseDepth += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        pauseDepth = Math.max(0, pauseDepth - 1);
      };
    },
  };
}
