# QA Report: {{feature_name}}

## Environment

- **Target**: {{target_url_or_service}}
- **Branch**: {{branch_name}}
- **Environment reachable**: {{yes_or_no}}
- **Setup blockers**: {{none_or_description}}

## Executed Checks

| #   | Flow          | Probe Type   | Command/Tool | Expected | Observed            | Status       |
| --- | ------------- | ------------ | ------------ | -------- | ------------------- | ------------ | ------------ | ------ | ------ |
| 1   | {{flow_name}} | {{happy_path | adversarial  | edge}}   | {{command_or_tool}} | {{expected}} | {{observed}} | {{pass | fail}} |

## Findings

| #   | Severity   | Category | Description | Evidence | Reproducible |
| --- | ---------- | -------- | ----------- | -------- | ------------ | --------------- | ---------------- | ----- | ---- |
| 1   | {{critical | high     | medium      | low}}    | {{category}} | {{description}} | {{evidence_ref}} | {{yes | no}} |

## Verdict

- **Verdict**: {{pass|fail|inconclusive}}
- **Basis**: {{summary_of_evidence}}

## Missing Evidence

- {{evidence_description_and_why_missing}}

## Confidence Gaps

- {{remaining_uncertainty}}

## Environment Limits

- {{access_or_tooling_limits}}
