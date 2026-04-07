#!/usr/bin/env python3
"""Validate Telegram message payload against API constraints.

Input JSON (stdin):
  {"text": str, "buttons": [[{"text":str,"callback_data":str}]], "parse_mode": str|null}

Output JSON (stdout):
  {"valid": bool, "errors": [str], "warnings": [str]}

Constraint reference (Telegram Bot API):
  - text length <= 4096 characters
  - button text <= 64 characters
  - callback_data <= 64 bytes (UTF-8)
  - max 100 buttons total
  - max 8 rows in inline keyboard
"""
import json
import sys

MAX_TEXT_LENGTH = 4096
MAX_BUTTON_TEXT = 64
MAX_CALLBACK_DATA_BYTES = 64
MAX_TOTAL_BUTTONS = 100
MAX_ROWS = 8
VALID_PARSE_MODES = {"HTML", "Markdown", "MarkdownV2"}


def validate(payload: dict) -> dict:
    errors: list[str] = []
    warnings: list[str] = []

    text = payload.get("text")
    if text is None:
        errors.append("'text' field is required")
    elif not isinstance(text, str):
        errors.append("'text' must be a string")
    else:
        if len(text) == 0:
            errors.append("'text' must not be empty")
        if len(text) > MAX_TEXT_LENGTH:
            errors.append(f"text length {len(text)} exceeds limit of {MAX_TEXT_LENGTH}")
        if len(text) > MAX_TEXT_LENGTH * 0.9:
            warnings.append(f"text is {len(text)} chars — near the {MAX_TEXT_LENGTH} limit")

    parse_mode = payload.get("parse_mode")
    if parse_mode is not None and parse_mode not in VALID_PARSE_MODES:
        errors.append(f"parse_mode '{parse_mode}' is not valid; expected one of {sorted(VALID_PARSE_MODES)}")

    buttons = payload.get("buttons")
    if buttons is not None:
        if not isinstance(buttons, list):
            errors.append("'buttons' must be a list of rows")
        else:
            if len(buttons) > MAX_ROWS:
                errors.append(f"button grid has {len(buttons)} rows, max is {MAX_ROWS}")

            total_buttons = 0
            for row_idx, row in enumerate(buttons):
                if not isinstance(row, list):
                    errors.append(f"row {row_idx} must be a list of button objects")
                    continue
                for btn_idx, btn in enumerate(row):
                    total_buttons += 1
                    if not isinstance(btn, dict):
                        errors.append(f"button [{row_idx}][{btn_idx}] must be an object")
                        continue

                    btn_text = btn.get("text", "")
                    if not btn_text:
                        errors.append(f"button [{row_idx}][{btn_idx}] has empty text")
                    elif len(btn_text) > MAX_BUTTON_TEXT:
                        errors.append(
                            f"button [{row_idx}][{btn_idx}] text length {len(btn_text)} "
                            f"exceeds limit of {MAX_BUTTON_TEXT}"
                        )

                    cb_data = btn.get("callback_data", "")
                    if cb_data:
                        cb_bytes = len(cb_data.encode("utf-8"))
                        if cb_bytes > MAX_CALLBACK_DATA_BYTES:
                            errors.append(
                                f"button [{row_idx}][{btn_idx}] callback_data is {cb_bytes} bytes, "
                                f"max is {MAX_CALLBACK_DATA_BYTES}"
                            )

            if total_buttons > MAX_TOTAL_BUTTONS:
                errors.append(f"total button count {total_buttons} exceeds limit of {MAX_TOTAL_BUTTONS}")
            if total_buttons == 0 and len(buttons) > 0:
                warnings.append("buttons array has rows but no actual buttons")

    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def main() -> None:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({"valid": False, "errors": ["no input provided on stdin"], "warnings": []}))
            return
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"valid": False, "errors": [f"invalid JSON input: {e}"], "warnings": []}))
        return

    result = validate(payload)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
