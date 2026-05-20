import { describe, expect, test } from "bun:test";
import {
  applyContextContract,
  buildContextContractBlock,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";

describe("context contract", () => {
  test("keeps the contract static and deduplicated", () => {
    const contract = buildContextContractBlock();
    const first = applyContextContract("base prompt");
    const refreshed = applyContextContract(first);

    expect(contract).toContain("[Brewva Context Contract]");
    expect(contract).not.toContain("%");
    expect(contract).not.toContain("compact soon when context pressure reaches high");
    expect(contract).not.toContain("compact immediately when context pressure becomes critical");
    expect(first).toBe(`base prompt\n\n${contract}`);
    expect(refreshed).toBe(first);
    expect(refreshed.match(/\[Brewva Context Contract\]/g)?.length).toBe(1);
  });

  test("keeps the environment block last when adding the contract", () => {
    const contract = buildContextContractBlock();
    const result = applyContextContract(
      "base prompt\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
    );

    expect(result).toBe(
      `base prompt\n\n${contract}\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo`,
    );
  });
});
