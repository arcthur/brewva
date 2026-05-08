export type A2ASendSuccessResult = {
  ok: true;
  toAgentId: string;
  responseText: string;
  depth?: number;
  hops?: number;
};

export type A2ASendFailureResult = {
  ok: false;
  toAgentId: string;
  error: string;
  depth?: number;
  hops?: number;
};

export type A2ASendResult = A2ASendSuccessResult | A2ASendFailureResult;

export type A2ABroadcastResult =
  | {
      ok: true;
      results: A2ASendSuccessResult[];
    }
  | {
      ok: false;
      error: string;
      results: A2ASendResult[];
    };
