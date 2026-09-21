// The execution driver is shared by in-process and portable workers. Provider
// access and approval/project operations are callbacks to the coordinator.
export async function runAgentLoop(
  { maxRounds = 20, parallelTools = [] },
  call,
  journal = async () => {},
) {
  const parallel = new Set(parallelTools);
  for (let round = 0; round < maxRounds; round++) {
    await journal({ type: 'round', round });
    await call('prepare');
    const result = await call('generate');
    if (!result || !Array.isArray(result.content)) throw new Error('Response interrupted.');
    await journal({ type: 'model_result', result });
    await call('message', result);
    if (result.stopReason === 'length')
      throw new Error(
        'Response interrupted by output limit. Review partial output before continuing.',
      );
    const calls = result.content.filter((c) => c.type === 'toolCall');
    let submitted = false;
    const execute = async (toolCall, alreadySubmitted = false) => {
      await journal({ type: 'tool_requested', call: toolCall });
      const outcome = await call('tool', { call: toolCall, submitted: alreadySubmitted });
      await journal({ type: 'tool_finished', callId: toolCall.id, outcome });
      return outcome;
    };
    if (calls.length > 1 && calls.every((toolCall) => parallel.has(toolCall.name))) {
      const outcomes = new Array(calls.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, calls.length) }, async () => {
          while (next < calls.length) {
            const index = next++;
            outcomes[index] = await execute(calls[index]);
          }
        }),
      );
      submitted = outcomes.some((outcome) => outcome?.submitted);
    } else {
      for (const toolCall of calls) {
        const outcome = await execute(toolCall, submitted);
        submitted ||= !!outcome?.submitted;
      }
    }
    if (await call('afterRound', { hasCalls: !!calls.length, submitted })) return;
  }
  throw new Error(
    `Agent step limit reached (${maxRounds} rounds). Review progress before continuing.`,
  );
}
