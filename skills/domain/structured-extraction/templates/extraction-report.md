# Extraction Report Template

Use this structure for `extraction_report` output.

## Fields

| Field            | Required | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| fields_extracted | yes      | Count of fields successfully extracted      |
| total_fields     | yes      | Count of total schema fields                |
| confidence       | yes      | overall / high / medium / low               |
| repairs          | yes      | List of mechanical repairs applied          |
| unresolved       | yes      | List of ambiguities left for human judgment |
| null_fields      | yes      | Fields set to null with reason              |
| source_quality   | yes      | clean / noisy / fragmentary                 |

## Example

```text
Extracted 8/10 fields from incident thread.
Confidence: medium.
Repairs: normalized severity format, trimmed whitespace from endpoint.
Unresolved: severity is ambiguous (P1 or P2) — kept as explicit uncertainty.
Null fields: incident_id (source provides no ID), root_cause (unconfirmed).
Source quality: noisy.
```
