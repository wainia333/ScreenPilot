import type { AppSettings } from './types'

export const DEFAULT_TRANSLATION_PROMPT =
  'Translate the following text to {lang}. Output only the translation.\n\nRules:\n- Preserve existing LaTeX formulas exactly (keep $...$ and $$...$$).\n- If formula-like plain text appears, normalize it to proper LaTeX when needed.\n- Keep the original line breaks and list structure when possible.\n- Do not add explanations.\n\n{text}'

export const DEFAULT_OCR_PROMPT =
  'Read all text in this screenshot and output only the recognized content as copy-ready Markdown.\n\nRules:\n- Do not translate, summarize, explain, or add content that is not visible.\n- Reconstruct natural paragraphs: merge visual line wraps inside the same paragraph.\n- Separate real paragraphs with one blank line.\n- Preserve document structure as Markdown when visible: headings, ordered lists, unordered lists, nested lists, block quotes, tables, code blocks, inline code, links, emphasis, bold, italic, strikethrough, and UI labels.\n- Preserve intentional line breaks for lists, tables, code, mathematical formulas, captions, and UI labels.\n- Output mathematical formulas in LaTeX: use $...$ for inline formulas and $$...$$ for standalone/display formulas.\n- Normalize fractions, superscripts, subscripts, roots, integrals, sums, matrices, Greek letters, and other mathematical symbols to proper LaTeX when they appear in formulas.\n- Preserve non-formula punctuation and symbols exactly.\n- Do not invent Markdown styling when the visual evidence is unclear.\n- Do not wrap the whole result in Markdown code fences; use code fences only for visible code blocks.\n- If no text is visible, output an empty string.'

export const DEFAULT_SCREENSHOT_TRANSLATION_PROMPT =
  'Translate the OCR text below to {lang}. Output only the translation.\n\nRules:\n- Preserve existing LaTeX formulas exactly (keep $...$ and $$...$$).\n- If formula-like plain text appears, normalize it to proper LaTeX when needed.\n- Keep paragraph and line-break structure from OCR text when possible.\n- Correct only obvious OCR character mistakes; do not invent missing content.\n- Do not add explanations.\n\n{text}'

export const DEFAULT_VISION_SYSTEM_PROMPT =
  '你是一位智能助手，能够看到用户分享的截图。请将其作为视觉上下文来理解和回答，可以涉及信息提取、概念解释、操作协助或任何相关话题。保持回答简洁直接，自然流畅，不用小标题和编号。数学公式用 LaTeX（$...$ 或 $$...$$）。思考保持简洁，避免反复重述。'

export const DEFAULT_VISION_QUESTION_PROMPT =
  '用户分享了这张截图，请结合其中的视觉信息来理解和回答：'

export const DEFAULT_OPTIMIZER_SYSTEM_PROMPT =
  '你是一个严谨、务实的提示词优化专家。你的目标不是把提示词写得更长，而是让模型更容易稳定地产出符合用户意图的结果。保留用户原始意图、关键约束、语气和必要变量；删除含糊、重复、相互冲突或不可执行的表达；补足角色、任务、上下文、输出格式、质量标准和边界条件。不要编造业务事实。'

export const DEFAULT_OPTIMIZER_PROMPT =
  '请优化下面的原始提示词，并使用 {lang} 输出。\n\n优化原则：\n- 先判断任务类型和目标用户，不盲目套模板。\n- 保留原始意图、硬性约束、变量占位符、输入输出字段和语气。\n- 将含糊要求改写为可执行的步骤、判断标准和输出格式。\n- 补足必要上下文、角色边界、禁止事项、异常处理和质量检查。\n- 如果原提示词已经足够清晰，只做轻量整理。\n- 不要添加与原任务无关的能力、工具、背景或事实。\n\n输出格式：\n## 优化后的提示词\n给出可直接复制使用的完整提示词。\n\n## 调整要点\n用 3-6 条短要点说明主要改动。\n\n原始提示词：\n{text}'

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  theme: 'system',
  language: 'zh',
  retry: {
    enabled: true,
    attempts: 3,
  },
  general: {
    autoPaste: true,
    launchAtStartup: false,
    launchAtStartupAsAdministrator: false,
    imageArchiveEnabled: false,
    imageArchivePath: '',
  },
  shortcuts: {
    translator: 'F2',
    vision: 'F3',
    screenshotTranslation: 'F4',
    promptOptimizer: 'Control+Alt+P',
  },
  translation: {
    sourceLanguage: 'auto',
    targetLanguage: 'auto',
    method: 'microsoft',
    aiEnabled: false,
    aiModel: null,
    prompt: DEFAULT_TRANSLATION_PROMPT,
  },
  screenshotTranslation: {
    enabled: true,
    sourceLanguage: 'auto',
    targetLanguage: 'auto',
    ocrAiEnabled: false,
    ocrMethod: 'chaoxing',
    translationMethod: 'microsoft',
    translationAiEnabled: false,
    ocrModel: null,
    translationModel: null,
    showSource: true,
    keepFullscreen: false,
    stream: true,
    thinking: false,
    thinkingEffort: 'medium',
    ocrPrompt: DEFAULT_OCR_PROMPT,
    translationPrompt: DEFAULT_SCREENSHOT_TRANSLATION_PROMPT,
  },
  vision: {
    enabled: true,
    responseLanguage: 'auto',
    model: null,
    stream: true,
    thinking: true,
    thinkingEffort: 'medium',
    webSearch: true,
    messageOrder: 'asc',
    keepFullscreen: false,
    systemPrompt: DEFAULT_VISION_SYSTEM_PROMPT,
    questionPrompt: DEFAULT_VISION_QUESTION_PROMPT,
  },
  promptOptimizer: {
    enabled: true,
    responseLanguage: 'auto',
    model: null,
    systemPrompt: DEFAULT_OPTIMIZER_SYSTEM_PROMPT,
    optimizePrompt: DEFAULT_OPTIMIZER_PROMPT,
  },
  providers: [],
}
