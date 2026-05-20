export interface ShellInputTrigger {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

function parseModifiedShellInputKey(inputKey: string): ShellInputTrigger {
  let keyPart = inputKey.toLowerCase();
  let ctrl = false;
  let meta = false;
  let shift = false;

  while (true) {
    const modified = /^(ctrl|control|meta|cmd|command|alt|option|shift)[+-](.+)$/u.exec(keyPart);
    if (!modified?.[1] || !modified[2]) {
      break;
    }
    switch (modified[1]) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "meta":
      case "cmd":
      case "command":
      case "alt":
      case "option":
        meta = true;
        break;
      case "shift":
        shift = true;
        break;
    }
    keyPart = modified[2];
  }

  return { key: keyPart, ctrl, meta, shift };
}

export function normalizeShellInputKey(inputKey: string): string {
  const lower = parseModifiedShellInputKey(inputKey).key;
  switch (lower) {
    case "return":
    case "linefeed":
      return "enter";
    case "esc":
      return "escape";
    case "arrowup":
    case "uparrow":
      return "up";
    case "arrowdown":
    case "downarrow":
      return "down";
    case "arrowleft":
    case "leftarrow":
      return "left";
    case "arrowright":
    case "rightarrow":
      return "right";
    case "pageup":
    case "page-up":
    case "pgup":
      return "pageup";
    case "pagedown":
    case "page-down":
    case "pgdown":
      return "pagedown";
    default:
      return lower;
  }
}

export function normalizeShellInputTrigger(trigger: ShellInputTrigger): ShellInputTrigger {
  const modified = parseModifiedShellInputKey(trigger.key);
  return {
    key: normalizeShellInputKey(modified.key),
    ctrl: trigger.ctrl || modified.ctrl,
    meta: trigger.meta || modified.meta,
    shift: trigger.shift || modified.shift,
  };
}
