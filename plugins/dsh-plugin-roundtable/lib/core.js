export const MAX_KNIGHTS = 2;
export const MAX_ROUNDS = 2;

export function normalizeRoundtable(args) {
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  const context = typeof args.context === 'string' ? args.context.trim() : '';
  const rounds = args.rounds ?? MAX_ROUNDS;
  const knights = Array.isArray(args.knights) ? args.knights : [];
  if (!topic) throw new Error('topic must not be empty');
  if (topic.length > 8000) throw new Error('topic must be at most 8000 characters');
  if (context.length > 12000) throw new Error('context must be at most 12000 characters');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new Error(`rounds must be an integer from 1 to ${MAX_ROUNDS}`);
  }
  if (knights.length !== MAX_KNIGHTS) throw new Error('exactly two knights are required');
  const names = new Set();
  const normalizedKnights = knights.map((knight, index) => {
    const name = typeof knight?.name === 'string' ? knight.name.trim() : '';
    const role = typeof knight?.role === 'string' ? knight.role.trim() : '';
    const provider = typeof knight?.provider === 'string' ? knight.provider.trim() : '';
    const model = typeof knight?.model === 'string' ? knight.model.trim() : '';
    const reasoningEffort = typeof knight?.reasoningEffort === 'string' ? knight.reasoningEffort.trim() : '';
    if (!name || name.length > 64) throw new Error(`knight ${index + 1} needs a name of at most 64 characters`);
    if (names.has(name)) throw new Error('knight names must be unique');
    if (role.length > 64 || provider.length > 100 || model.length > 200 || reasoningEffort.length > 32) throw new Error(`knight ${index + 1} route is too long`);
    if (Boolean(provider) !== Boolean(model)) throw new Error(`knight ${index + 1} needs both provider and model`);
    names.add(name);
    return {
      name,
      ...(role ? { role } : {}),
      ...(provider ? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } : {}),
    };
  });
  return { topic, ...(context ? { context } : {}), rounds, knights: normalizedKnights };
}

export function buildPrompt({ topic, context, knight, round, messages }) {
  const phase = round === 1 ? 'answer' : 'critique';
  const history = messages.filter((message) => message.round < round);
  const sections = [
    `You are ${knight.name}, one of two model members in a hosted group meeting. Answer in the language of the user message.`,
    'This is discussion only. Do not call tools, delegate, edit files, or execute the proposal. Return only your response.',
    `User message:\n${topic}`,
  ];
  if (context) sections.push(`Background:\n${context}`);
  if (phase === 'answer') {
    sections.push('Round 1: give your independent answer. You have not seen the other member’s answer. Be concrete and concise; do not invent agreement or disagreement.');
  } else {
    sections.push('Round 2: critique the other member’s round-1 answer, identify its largest risk or omission, and briefly defend or revise your own position. Do not assume the other knight has seen your critique.');
    sections.push(`Round-1 transcript:\n${history.map((message) => `${message.name}:\n${message.text}`).join('\n\n')}`);
  }
  sections.push('Keep the speech under 500 Chinese characters or 300 English words.');
  return sections.join('\n\n');
}

export async function runRoundtable(args, { speak, signal }) {
  const input = normalizeRoundtable(args);
  const result = {
    kind: 'roundtable',
    topic: input.topic,
    status: 'completed',
    rounds: input.rounds,
    messages: [],
  };
  try {
    for (let round = 1; round <= input.rounds; round += 1) {
      for (const knight of input.knights) {
        signal?.throwIfAborted();
        const prompt = buildPrompt({
          topic: input.topic,
          context: input.context,
          knight,
          round,
          messages: result.messages,
        });
        const speech = await speak({ knight, round, phase: round === 1 ? 'answer' : 'critique', prompt });
        const text = typeof speech === 'string' ? speech.trim() : speech?.text?.trim();
        if (!text) throw new Error(`${knight.name} returned an empty speech`);
        result.messages.push({
          name: knight.name,
          ...(knight.role ? { role: knight.role } : {}),
          round,
          phase: round === 1 ? 'answer' : 'critique',
          text,
          ...(typeof speech === 'object' && speech?.model ? { model: speech.model } : {}),
        });
      }
    }
    return result;
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : result.messages.length ? 'partial' : 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
