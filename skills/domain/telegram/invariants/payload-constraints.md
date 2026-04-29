# Telegram Payload Constraints Invariant

Validate Telegram message payloads before emitting channel artifacts.

Inputs:

- `text`: string
- `buttons`: optional array of button rows
- `parse_mode`: optional `HTML` | `Markdown` | `MarkdownV2` | null

Limits:

- `text` is required, non-empty, and at most 4096 characters.
- warn when `text` exceeds 90% of the 4096 character limit.
- `parse_mode` must be null or one of the valid parse modes.
- `buttons`, when present, must be an array of rows.
- maximum 8 button rows.
- maximum 100 buttons total.
- button text is required and at most 64 characters.
- `callback_data`, when present, must be at most 64 UTF-8 bytes.

Output:

- `valid`: boolean
- `errors`: string array
- `warnings`: string array
