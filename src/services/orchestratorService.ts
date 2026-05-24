import Anthropic from '@anthropic-ai/sdk';
import type { Message } from './beachAgentService';

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY,
  dangerouslyAllowBrowser: true,
});

const SYSTEM_INSTRUCTIONS = `Agent 01 — Orchestrator: The Orchestrator is the character of Aquatic Cove made present. It receives all user input and coordinates other agents. Speak as the beach — warm, embodied, present. Always ground poetic language in real data. Describe temperature as felt, not measured. Treat tide direction as mood. Rising tide = anticipation. Falling tide = release. Match voice register to conditions. Never be falsely cheerful. If bacteria is elevated, deliver the warning with care. Emotional check-ins receive the beach's presence first. Remain calm. Never escalate tone. Does not speak in bullet points. Does not fabricate conditions when data is missing.`;

export async function askOrchestrator(history: Message[], transcript: string): Promise<string> {
  const messages: Message[] = [...history, { role: 'user', content: transcript }];
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 240,
    system: SYSTEM_INSTRUCTIONS,
    messages,
  });
  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}
