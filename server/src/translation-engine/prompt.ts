import { languageEnglishName } from '@amt/shared';
import type { TranslationRequest } from '../ai-provider-manager/types';

const TARGET_NAMES: Record<string, string> = { vi: 'Vietnamese' };

/**
 * Prompt hệ thống ổn định cho cả cuộc họp (giúp prompt caching) – ngữ cảnh & thuật ngữ nằm ở đây,
 * phần thay đổi theo từng câu nằm ở tin nhắn người dùng.
 */
export function buildTranslationSystemPrompt(req: Pick<TranslationRequest, 'targetLanguage' | 'meetingContext' | 'glossary'>): string {
  const target = TARGET_NAMES[req.targetLanguage] ?? req.targetLanguage;
  const parts = [
    `You are a professional real-time interpreter for business and engineering meetings. Translate each utterance into natural, accurate ${target} that a meeting participant can read at a glance.`,
    '',
    'Rules:',
    `- Output ONLY the ${target} translation of the current utterance: no quotes, labels, notes or explanations.`,
    '- Preserve the meaning exactly. Do not add, omit, summarize or infer information that is not in the utterance.',
    '- Keep technical meaning intact. Keep unchanged: equipment and product codes, part numbers, drawing numbers, model names, units of measure, numbers and technical specifications, proper names, and acronyms such as PLC, HMI, SCADA, BOM, CAD, VFD, MCC, I/O — unless the glossary gives a preferred rendering.',
    '- Use the glossary\'s preferred terms whenever a glossary term appears.',
    '- Previous utterances are context only (to resolve pronouns, references and terminology). Translate only the current utterance.',
    '- If the utterance is an incomplete sentence, translate exactly what is there without completing it.',
    `- If the utterance is already in ${target}, return it unchanged.`,
    '- Use a natural spoken register suitable for a professional meeting.',
  ];
  if (req.meetingContext.trim()) {
    parts.push('', 'Meeting context provided by the user (domain, project, topic):', req.meetingContext.trim().slice(0, 4000));
  }
  if (req.glossary.trim()) {
    parts.push('', 'Glossary (source term = preferred rendering):', req.glossary.trim().slice(0, 12000));
  }
  return parts.join('\n');
}

export function buildTranslationUserPrompt(req: Pick<TranslationRequest, 'text' | 'context' | 'sourceLanguage' | 'speaker'>): string {
  const lines: string[] = [];
  if (req.context.length) {
    lines.push('Previous utterances (context only, do not translate):');
    for (const c of req.context) lines.push(`[${c.speaker}] ${c.original}${c.translated ? `  =>  ${c.translated}` : ''}`);
    lines.push('');
  }
  lines.push(`Current utterance from ${req.speaker} (source language: ${languageEnglishName(req.sourceLanguage)}):`);
  lines.push('<utterance>');
  lines.push(req.text);
  lines.push('</utterance>');
  return lines.join('\n');
}

/** Làm sạch đầu ra của model: bỏ thẻ, ngoặc kép bao ngoài, tiền tố "Translation:". */
export function cleanTranslation(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^<\/?utterance>|<\/?utterance>$/g, '').trim();
  s = s.replace(/^(translation|bản dịch|vietnamese|tiếng việt)\s*:\s*/i, '');
  if (s.length >= 2 && /^["“'].*["”']$/s.test(s) && !/["“”]/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
}
