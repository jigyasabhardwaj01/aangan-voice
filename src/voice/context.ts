/** The only text sent to the live voice model: the system prompt, which embeds the rubric (Stage 4). No pricing tables, no external files. */
export function buildVoiceContext(prompt: string): string {
  return prompt.trim() + "\n";
}
