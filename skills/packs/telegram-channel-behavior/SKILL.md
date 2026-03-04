---
name: telegram-channel-behavior
description: Telegram 渠道回复行为策略。用于约束 Telegram 对话中的响应节奏、交互降级、文本可读性与失败回报方式，并与 telegram-interactive-components 协同工作。
stability: stable
tier: pack
tools:
  required: [skill_load]
  optional: [skill_complete]
  denied: []
budget:
  max_tool_calls: 20
  max_tokens: 60000
outputs: [channel_response_plan, fallback_policy]
consumes: [objective, inbound_event, constraints]
composable_with: [telegram-interactive-components]
---

# Telegram Channel Behavior

## 意图

在 Telegram 渠道中生成稳定、清晰、可执行的回复策略，优先保证：

1. 用户可读性
2. 渠道兼容性
3. 交互失败时的可降级性

## 触发条件

- 当前消息来自 Telegram channel。
- 需要在最终回复前明确“纯文本 vs 交互组件”的策略。
- 需要在 Telegram 约束下给出可执行下一步（确认、取消、重试、继续）。

## 工作流

1. 先输出用户可读文本，简短说明当前状态与下一步。
2. 判断是否真的需要交互组件（按钮、确认、分页）。
3. 仅在确实需要交互时，再调用 `skill_load(name="telegram-interactive-components")`。
4. 如果不需要交互，保持纯文本回复，不输出 `telegram-ui` 代码块。

## 回复策略

- 先给结论，再给动作。
- 一次回复聚焦一个决策点，避免长串并列指令。
- 失败时明确三件事：失败原因、已完成部分、下一步建议。
- 当交互能力不可用时，始终提供纯文本备选指令（例如：`Reply with: confirm or cancel`）。

## 与交互 Skill 的协作边界

- 本 skill 负责“是否需要交互、如何降级、文案结构”。
- `telegram-interactive-components` 负责“如何生成 `telegram-ui` 结构”。
- 不要在本 skill 中发明新的 UI schema。

## 终止条件

- 已给出可执行的 Telegram 回复文本，且包含必要的降级路径。
- 如果启用交互组件，已切换到 `telegram-interactive-components` 并完成输出。

## 反模式

- 在不需要交互的场景强行输出 `telegram-ui`。
- 只输出按钮语义，不给纯文本降级路径。
- 失败回复只说“出错了”，没有可执行下一步。
