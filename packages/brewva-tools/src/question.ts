import {
  normalizeQuestionPrompt,
  validateQuestionAnswers,
} from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaInteractiveQuestionRequest,
  BrewvaQuestionPrompt,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { failTextResult, textResult } from "./utils/result.js";
import { createManagedBrewvaToolFactory } from "./utils/runtime-bound-tool.js";

const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
});

const QuestionPromptSchema = Type.Object({
  header: Type.String({ minLength: 1, maxLength: 30 }),
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  options: Type.Array(QuestionOptionSchema, { minItems: 0, maxItems: 12 }),
  multiple: Type.Optional(Type.Boolean()),
  custom: Type.Optional(Type.Boolean()),
});

const QuestionSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  questions: Type.Array(QuestionPromptSchema, { minItems: 1, maxItems: 8 }),
});

function formatAnswerSummary(
  questions: readonly BrewvaQuestionPrompt[],
  answers: readonly (readonly string[])[],
): string {
  return questions
    .map((question, index) => {
      const answerText = (answers[index] ?? []).join(", ") || "Unanswered";
      return `"${question.question}"="${answerText}"`;
    })
    .join(", ");
}

export function createQuestionTool(): ToolDefinition {
  const questionTool = createManagedBrewvaToolFactory("question");
  return questionTool.define(
    {
      name: "question",
      label: "Question",
      description:
        "Ask the user one or more structured questions in the TUI, wait for their answers, then continue with those answers as authoritative input.",
      promptSnippet: "Ask the user one or more structured questions and wait for their answers.",
      promptGuidelines: [
        "Use this when progress depends on user input and the available options can be presented clearly.",
        "Use question instead of plain assistant prose when a missing user decision blocks correct execution right now.",
        "Prefer question over deferring blocking user input into open_questions or similar end-of-turn artifacts.",
        "Prefer 1-3 focused questions, concise headers, and short option labels with useful descriptions.",
        "Set custom=false when free-form answers would reduce decision quality.",
      ],
      parameters: QuestionSchema,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        if (!ctx.hasUI) {
          return failTextResult("Question tool requires an interactive UI host.", {
            ok: false,
            error: "ui_unavailable",
          });
        }

        const normalizedQuestions = params.questions.map((question) =>
          normalizeQuestionPrompt(question),
        );
        if (normalizedQuestions.some((question) => question === null)) {
          return failTextResult("Question request contains an invalid or unanswerable prompt.", {
            ok: false,
            error: "invalid_question_request",
          });
        }
        const questions = normalizedQuestions.filter(
          (question): question is BrewvaQuestionPrompt => question !== null,
        );

        const request: BrewvaInteractiveQuestionRequest = {
          toolCallId,
          title: params.title,
          questions,
        };
        const answers = await ctx.ui.custom<readonly (readonly string[])[] | undefined>(
          "question",
          request,
          { signal },
        );
        if (!answers) {
          return failTextResult("Question was dismissed without an answer.", {
            ok: false,
            error: "question_rejected",
          });
        }
        const validatedAnswers = validateQuestionAnswers({
          questions,
          answers,
        });
        if (!validatedAnswers.ok) {
          return failTextResult(validatedAnswers.error, {
            ok: false,
            error: "invalid_question_answer",
          });
        }

        return textResult(
          `User answered: ${formatAnswerSummary(questions, validatedAnswers.answers)}.`,
          {
            ok: true,
            answers: validatedAnswers.answers,
            questionCount: questions.length,
          },
          {
            summaryText: params.title ?? `Asked ${questions.length} question(s)`,
          },
        );
      },
    },
    {
      surface: "base",
      actionClass: "runtime_observe",
      executionTraits: {
        concurrencySafe: false,
        interruptBehavior: "block",
        streamingEligible: false,
        contextModifying: false,
      },
    },
  );
}
