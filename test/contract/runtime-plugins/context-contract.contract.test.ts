import { describe, expect, test } from "bun:test";
import {
  applyContextContract,
  buildContextContractBlock,
} from "@brewva/brewva-gateway/runtime-plugins";

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
});
