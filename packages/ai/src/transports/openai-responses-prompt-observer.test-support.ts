export function rejectedSdkStream(
  error: { message: string; code?: string; status?: number },
  options?: { events?: unknown[]; nestedErrorEvent?: boolean },
): { data: AsyncIterable<unknown>; response: Response } {
  return {
    data: (async function* () {
      yield* options?.events ?? [];
      if (options?.nestedErrorEvent) {
        yield { type: "error", error };
        return;
      }
      yield {
        type: "response.failed",
        response: {
          id: "resp_rejected",
          status: "failed",
          model: "rejected-model",
          error,
          output: [],
          usage: { input_tokens: 99, output_tokens: 0, total_tokens: 99 },
        },
      };
    })(),
    response: new Response(null, { status: 200 }),
  };
}
