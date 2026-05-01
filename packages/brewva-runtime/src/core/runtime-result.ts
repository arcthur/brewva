export type RuntimeSuccess<TValue extends Record<string, unknown> = {}> = {
  ok: true;
} & TValue;

export type RuntimeFailure<TReason extends string = string> = {
  ok: false;
  reason: TReason;
};

export type RuntimeResult<
  TValue extends Record<string, unknown> = {},
  TReason extends string = string,
> = RuntimeSuccess<TValue> | RuntimeFailure<TReason>;
