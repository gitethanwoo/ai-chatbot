import type { AgentMention } from '@/lib/types';

const mentionPattern = /@([a-z0-9][\w-]{0,63})/gi;
const agentResponseHeadingPattern =
  /^###\s+Response from @([a-z0-9][\w-]*)(?: \((.+?)\))?/i;

/**
 * Extract structured agent mentions from a free-form user input string.
 * The content sent to each agent is captured from immediately after the
 * mention token up until the next mention or the end of the string.
 */
export function extractAgentMentions(input: string): AgentMention[] {
  if (!input) return [];

  const matches = Array.from(input.matchAll(mentionPattern));

  if (matches.length === 0) {
    return [];
  }

  return matches
    .map((match, index) => {
      const rawSlug = match[1]?.trim();
      if (!rawSlug) return null;

      const slug = rawSlug.toLowerCase();
      const matchIndex = match.index ?? 0;
      const promptStart = matchIndex + match[0].length;
      const nextMatch = matches[index + 1];
      const promptEnd = nextMatch?.index ?? input.length;
      const rawPrompt = input.slice(promptStart, promptEnd);
      const prompt = rawPrompt.replace(/^[\s:\-–—]+/, '').trim();

      return {
        slug,
        prompt,
      } satisfies AgentMention;
    })
    .filter((mention): mention is AgentMention => Boolean(mention));
}

/**
 * Remove the mention directive content from the message for display or routing
 * to the default assistant. Mentions remain as readable `@slug` tokens.
 */
export function stripAgentDirectiveText(
  input: string,
  mentions: AgentMention[],
): string {
  if (mentions.length === 0) return input;

  let output = input;

  mentions.forEach((mention) => {
    if (!mention.prompt) return;
    const directivePattern = new RegExp(
      `(?!^)@${escapeRegExp(mention.slug)}[\s:\-–—]+${escapeRegExp(
        mention.prompt,
      )}`,
      'i',
    );

    output = output.replace(directivePattern, `@${mention.slug}`);
  });

  return output.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseAgentResponseText(text: string) {
  if (!text) return null;

  const trimmed = text.trimStart();
  const match = trimmed.match(agentResponseHeadingPattern);
  if (!match) return null;

  const [, slugRaw, name] = match;
  const slug = slugRaw.toLowerCase();
  const body = trimmed.slice(match[0].length).trimStart();

  return {
    slug,
    agentName: name ?? undefined,
    body,
  };
}
