//! Conservative, provider-independent cleanup for line-oriented OCR output.
//!
//! The processor keeps structural blocks intact, detects script-specific
//! typography, and only merges lines when the provider has not supplied
//! explicit paragraph groups. It intentionally avoids spelling correction or
//! invented punctuation because those transformations cannot be made losslessly.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BlockKind {
    Paragraph,
    Heading,
    List,
    Table,
    Code,
}

#[derive(Debug)]
struct Block {
    kind: BlockKind,
    text: String,
}

/// Normalize OCR lines when the provider exposes no paragraph structure.
pub fn normalize_ocr_lines(lines: &[String]) -> String {
    let flattened = flatten_lines(lines);
    if flattened.is_empty() {
        return String::new();
    }

    let typical_width = typical_line_width(&flattened);
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut paragraph_line_count = 0usize;

    for (index, line) in flattened.iter().enumerate() {
        let Some(raw_line) = line else {
            flush_paragraph(&mut blocks, &mut paragraph, &mut paragraph_line_count);
            continue;
        };

        let kind = classify_line(raw_line, index, &flattened, typical_width);
        let normalized = normalize_line(raw_line, kind);
        if normalized.is_empty() {
            flush_paragraph(&mut blocks, &mut paragraph, &mut paragraph_line_count);
            continue;
        }

        if kind != BlockKind::Paragraph {
            flush_paragraph(&mut blocks, &mut paragraph, &mut paragraph_line_count);
            push_block(&mut blocks, kind, normalized);
            continue;
        }

        append_soft_line(&mut paragraph, &normalized);
        paragraph_line_count += 1;

        if should_end_paragraph(
            raw_line,
            index,
            &flattened,
            typical_width,
            paragraph_line_count,
        ) {
            flush_paragraph(&mut blocks, &mut paragraph, &mut paragraph_line_count);
        }
    }

    flush_paragraph(&mut blocks, &mut paragraph, &mut paragraph_line_count);
    render_blocks(&blocks)
}

/// Normalize provider-supplied paragraphs while preserving their boundaries.
pub fn normalize_ocr_paragraphs(paragraphs: &[Vec<String>]) -> String {
    paragraphs
        .iter()
        .filter_map(|paragraph| {
            let lines = flatten_lines(paragraph);
            let mut blocks = Vec::new();
            let mut prose = String::new();
            let mut prose_line_count = 0usize;

            for line in lines.into_iter().flatten() {
                let kind = classify_explicit_line(&line);
                let normalized = normalize_line(&line, kind);
                if normalized.is_empty() {
                    continue;
                }
                if kind == BlockKind::Paragraph {
                    append_soft_line(&mut prose, &normalized);
                    prose_line_count += 1;
                } else {
                    flush_paragraph(&mut blocks, &mut prose, &mut prose_line_count);
                    push_block(&mut blocks, kind, normalized);
                }
            }
            flush_paragraph(&mut blocks, &mut prose, &mut prose_line_count);

            let rendered = render_blocks(&blocks);
            (!rendered.is_empty()).then_some(rendered)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Normalize punctuation and spacing without changing existing line or
/// paragraph boundaries.
pub fn normalize_text_typography(value: &str) -> String {
    normalize_text_typography_with_language(value, None)
}

/// Normalize punctuation and spacing using the requested output language as
/// authoritative context. This matters for CJK sentences whose final token is
/// Latin text, for example `支持 ARM64.` -> `支持 ARM64。`.
pub fn normalize_text_typography_for_language(value: &str, language: &str) -> String {
    if matches!(
        language,
        "zh" | "zh-CN" | "zh-TW" | "zh-Hans" | "zh-Hant" | "ja" | "en" | "ko"
    ) {
        normalize_text_typography_with_language(value, Some(language))
    } else {
        normalize_text_typography(value)
    }
}

fn normalize_text_typography_with_language(value: &str, language: Option<&str>) -> String {
    let cjk_context = language.and_then(|language| match language {
        "zh" | "zh-CN" | "zh-TW" | "zh-Hans" | "zh-Hant" | "ja" => Some(true),
        "en" | "ko" => Some(false),
        _ => None,
    });
    let mut output = String::with_capacity(value.len() + 8);
    let mut line_start = 0usize;
    let mut characters = value.char_indices().peekable();

    while let Some((index, character)) = characters.next() {
        if !matches!(character, '\r' | '\n') {
            continue;
        }

        let kind = classify_explicit_line(&value[line_start..index]);
        output.push_str(&normalize_line_with_context(
            &value[line_start..index],
            kind,
            cjk_context,
        ));

        if character == '\r' && characters.peek().is_some_and(|(_, next)| *next == '\n') {
            let (newline_index, _) = characters.next().expect("peeked CRLF newline");
            output.push_str("\r\n");
            line_start = newline_index + 1;
        } else {
            output.push(character);
            line_start = index + character.len_utf8();
        }
    }

    let kind = classify_explicit_line(&value[line_start..]);
    output.push_str(&normalize_line_with_context(
        &value[line_start..],
        kind,
        cjk_context,
    ));
    output
}

fn flatten_lines(lines: &[String]) -> Vec<Option<String>> {
    let mut flattened = Vec::new();
    for value in lines {
        let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
        for line in normalized.split('\n') {
            let trimmed = line.trim_matches(|character: char| character.is_whitespace());
            if trimmed.is_empty() {
                if flattened.last().is_some_and(Option::is_some) {
                    flattened.push(None);
                }
            } else {
                flattened.push(Some(trimmed.to_string()));
            }
        }
    }
    while flattened.last().is_some_and(Option::is_none) {
        flattened.pop();
    }
    flattened
}

fn typical_line_width(lines: &[Option<String>]) -> usize {
    let mut widths = lines
        .iter()
        .filter_map(Option::as_deref)
        .filter(|line| classify_explicit_line(line) == BlockKind::Paragraph)
        .map(display_width)
        .filter(|width| *width > 0)
        .collect::<Vec<_>>();
    if widths.is_empty() {
        return 0;
    }
    widths.sort_unstable();
    widths[widths.len() / 2]
}

fn display_width(value: &str) -> usize {
    value
        .chars()
        .map(|character| usize::from(is_cjk(character)) + 1)
        .sum()
}

fn classify_line(
    line: &str,
    index: usize,
    lines: &[Option<String>],
    typical_width: usize,
) -> BlockKind {
    let explicit = classify_explicit_line(line);
    if explicit != BlockKind::Paragraph {
        return explicit;
    }

    if looks_like_heading(line, index, lines, typical_width) {
        BlockKind::Heading
    } else {
        BlockKind::Paragraph
    }
}

fn classify_explicit_line(line: &str) -> BlockKind {
    let trimmed = line.trim();
    if is_code_line(trimmed) {
        BlockKind::Code
    } else if is_table_line(trimmed) {
        BlockKind::Table
    } else if is_list_line(trimmed) {
        BlockKind::List
    } else if is_explicit_heading(trimmed) {
        BlockKind::Heading
    } else {
        BlockKind::Paragraph
    }
}

fn is_code_line(line: &str) -> bool {
    line.starts_with("```")
        || line.starts_with("~~~")
        || line.starts_with("#include")
        || line.starts_with("</")
        || line.starts_with("<?")
        || line.starts_with('{')
        || line == "}"
        || line.contains("=>")
        || line.contains("::")
        || line.contains("();")
        || line.contains("</")
        || line.contains("/>")
}

fn is_table_line(line: &str) -> bool {
    let pipes = line.chars().filter(|character| *character == '|').count();
    pipes >= 2 || line.contains('\t')
}

fn is_list_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if ["- ", "* ", "+ ", "• ", "· ", "● ", "○ ", "▪ ", "‣ "]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return true;
    }

    let mut chars = trimmed.chars().peekable();
    let mut digits = 0usize;
    while chars
        .peek()
        .is_some_and(|character| character.is_ascii_digit())
    {
        chars.next();
        digits += 1;
    }
    digits > 0
        && matches!(chars.next(), Some('.') | Some(')') | Some('、'))
        && chars
            .next()
            .is_some_and(|character| character.is_whitespace())
}

fn is_explicit_heading(line: &str) -> bool {
    if line.starts_with('#') && line.chars().find(|character| *character != '#') == Some(' ') {
        return true;
    }
    if line.chars().count() > 80 || ends_sentence(line) {
        return false;
    }

    let letters = line
        .chars()
        .filter(|character| character.is_alphabetic())
        .count();
    let uppercase = line
        .chars()
        .filter(|character| character.is_ascii_uppercase())
        .count();
    letters >= 2 && uppercase == letters
}

fn looks_like_heading(
    line: &str,
    index: usize,
    lines: &[Option<String>],
    typical_width: usize,
) -> bool {
    if typical_width == 0 || ends_sentence(line) || line.chars().count() > 80 {
        return false;
    }
    let width = display_width(line);
    let next_width = lines
        .iter()
        .skip(index + 1)
        .find_map(Option::as_deref)
        .map(display_width)
        .unwrap_or(0);
    let starts_section = starts_section_heading(line);
    let isolated_before = index == 0
        || lines
            .get(index.wrapping_sub(1))
            .is_some_and(Option::is_none);
    let substantially_shorter = width.saturating_mul(2) < typical_width.max(next_width);

    starts_section || (isolated_before && substantially_shorter && next_width > width)
}

fn starts_section_heading(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with('第')
        && ["章", "节", "部分", "篇"].iter().any(|marker| {
            trimmed
                .chars()
                .take(12)
                .collect::<String>()
                .contains(marker)
        })
    {
        return true;
    }

    let first = trimmed.split_whitespace().next().unwrap_or_default();
    let marker = first.trim_end_matches(&['.', '、', ')'][..]);
    !marker.is_empty()
        && marker.chars().all(|character| {
            character.is_ascii_digit() || matches!(character, 'I' | 'V' | 'X' | 'i' | 'v' | 'x')
        })
        && first != marker
}

fn normalize_line(line: &str, kind: BlockKind) -> String {
    normalize_line_with_context(line, kind, None)
}

fn normalize_line_with_context(line: &str, kind: BlockKind, cjk_context: Option<bool>) -> String {
    if matches!(kind, BlockKind::Code | BlockKind::Table) {
        return line.trim_end().to_string();
    }

    let collapsed = collapse_spaces(line);
    let chars = collapsed.chars().collect::<Vec<_>>();
    let cjk_dominant = cjk_context.unwrap_or_else(|| dominant_cjk(&chars));
    let mut output = String::with_capacity(collapsed.len() + 8);
    let mut in_inline_code = false;

    for (index, character) in chars.iter().copied().enumerate() {
        if character == '`' {
            in_inline_code = !in_inline_code;
            output.push(character);
            continue;
        }
        if in_inline_code {
            output.push(character);
            continue;
        }

        if character == ' ' {
            let previous = output.chars().next_back();
            let next = chars.get(index + 1).copied();
            if previous.is_none()
                || previous.is_some_and(is_opening_punctuation)
                || next.is_some_and(is_closing_punctuation)
                || previous.is_some_and(is_cjk_punctuation)
                || next.is_some_and(is_cjk_punctuation)
                || (previous.is_some_and(is_unspaced_cjk) && next.is_some_and(is_unspaced_cjk))
            {
                continue;
            }
            if !output.ends_with(' ') {
                output.push(' ');
            }
            continue;
        }

        let previous = previous_non_space(&chars, index);
        let next = next_non_space(&chars, index);
        let normalized_character = if should_restore_ascii_period(&chars, index, character) {
            '.'
        } else if should_use_full_width_punctuation(
            &chars,
            index,
            character,
            cjk_dominant,
            previous,
            next,
        ) {
            full_width_punctuation(character).unwrap_or(character)
        } else {
            character
        };

        if is_closing_punctuation(normalized_character) || is_cjk_punctuation(normalized_character)
        {
            while output.ends_with(' ') {
                output.pop();
            }
        }
        output.push(normalized_character);

        if should_insert_english_space(&chars, index, normalized_character)
            && !output.ends_with(' ')
        {
            output.push(' ');
        }
    }

    output.trim().to_string()
}

fn should_use_full_width_punctuation(
    chars: &[char],
    index: usize,
    character: char,
    cjk_context: bool,
    previous: Option<char>,
    next: Option<char>,
) -> bool {
    if !cjk_context || full_width_punctuation(character).is_none() {
        return false;
    }

    // Sentence punctuation follows the surrounding language, not the script
    // of the final word. Only closing quotes/brackets may follow it.
    if matches!(character, '.' | '?' | '!')
        && previous.is_some()
        && chars[index + 1..]
            .iter()
            .all(|value| value.is_whitespace() || is_closing_delimiter(*value))
    {
        return true;
    }

    // Preserve the existing conservative behavior inside a sentence, while
    // also handling a Latin token immediately followed by CJK prose.
    (previous.is_some_and(is_cjk)
        && (next.is_none()
            || next.is_some_and(|value| is_cjk(value) || is_closing_punctuation(value))))
        || (next.is_some_and(is_cjk) && matches!(character, ',' | ';' | ':' | '?' | '!'))
}

fn collapse_spaces(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() || character == '\u{00a0}' || character == '\u{3000}' {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
            }
            output.push(character);
            pending_space = false;
        }
    }
    output
}

fn dominant_cjk(chars: &[char]) -> bool {
    let cjk = chars
        .iter()
        .filter(|character| is_unspaced_cjk(**character))
        .count();
    let mut latin_words = 0usize;
    let mut in_latin_word = false;
    for character in chars {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            if !in_latin_word {
                latin_words += 1;
                in_latin_word = true;
            }
        } else {
            in_latin_word = false;
        }
    }

    cjk > 0 && cjk >= latin_words.saturating_mul(2)
}

fn should_insert_english_space(chars: &[char], index: usize, punctuation: char) -> bool {
    if !matches!(punctuation, '.' | ',' | ';' | ':' | '?' | '!') {
        return false;
    }

    let Some(next_index) = next_content_index(chars, index + 1) else {
        return false;
    };
    if next_index != index + 1 {
        return false;
    }
    let mut next_character = chars[next_index];
    if is_opening_punctuation(next_character) {
        let Some(content_index) = next_content_index(chars, next_index + 1) else {
            return false;
        };
        next_character = chars[content_index];
    }
    if !next_character.is_alphanumeric() {
        return false;
    }

    let previous = index
        .checked_sub(1)
        .and_then(|position| chars.get(position))
        .copied();
    if matches!(punctuation, '.' | ',' | ':')
        && previous.is_some_and(|character| character.is_ascii_digit())
        && next_character.is_ascii_digit()
    {
        return false;
    }

    match punctuation {
        '.' => should_space_after_period(chars, index, next_character),
        ':' => !has_protected_colon_scheme(chars, index),
        _ => true,
    }
}

fn should_space_after_period(chars: &[char], index: usize, next_character: char) -> bool {
    if is_known_abbreviation_ending(chars, index) {
        return true;
    }

    let right = label_after(chars, index);
    if right.is_empty() {
        return true;
    }
    if is_known_domain_or_file_suffix(&right) {
        return false;
    }

    let left = label_before(chars, index);
    if left.is_empty() {
        return true;
    }
    if token_has_url_marker(chars, index) {
        return is_known_domain_or_file_suffix(&left) && next_character.is_ascii_uppercase();
    }
    if left.len() == 1
        && right.len() == 1
        && left
            .chars()
            .all(|character| character.is_ascii_alphabetic())
        && right
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return false;
    }
    if left.chars().all(|character| character.is_ascii_lowercase())
        && next_character.is_ascii_lowercase()
    {
        return false;
    }

    true
}

fn should_restore_ascii_period(chars: &[char], index: usize, character: char) -> bool {
    matches!(character, '。' | '．')
        && previous_non_space(chars, index).is_some()
        && is_known_domain_or_file_suffix(&label_after(chars, index))
}

fn label_before(chars: &[char], index: usize) -> String {
    let start = chars[..index]
        .iter()
        .rposition(|character| !is_identifier_character(*character))
        .map_or(0, |position| position + 1);
    chars[start..index].iter().collect()
}

fn label_after(chars: &[char], index: usize) -> String {
    chars[index + 1..]
        .iter()
        .take_while(|character| is_identifier_character(**character))
        .collect()
}

fn is_identifier_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn token_has_url_marker(chars: &[char], index: usize) -> bool {
    let start = chars[..index]
        .iter()
        .rposition(|character| {
            character.is_whitespace() || matches!(character, '(' | '[' | '{' | '<')
        })
        .map_or(0, |position| position + 1);
    let end = chars[index + 1..]
        .iter()
        .position(|character| {
            character.is_whitespace() || matches!(character, ')' | ']' | '}' | '>')
        })
        .map_or(chars.len(), |position| index + 1 + position);
    let token = chars[start..end].iter().collect::<String>();
    token.contains("://") || token.contains('@') || token.starts_with("www.")
}

fn is_known_domain_or_file_suffix(value: &str) -> bool {
    let suffix = value.to_ascii_lowercase();
    matches!(
        suffix.as_str(),
        "com"
            | "org"
            | "net"
            | "edu"
            | "gov"
            | "io"
            | "ai"
            | "cn"
            | "uk"
            | "de"
            | "jp"
            | "app"
            | "dev"
            | "co"
            | "me"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "json"
            | "xml"
            | "yaml"
            | "yml"
            | "md"
            | "txt"
            | "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "png"
            | "jpg"
            | "jpeg"
            | "svg"
            | "ico"
            | "bmp"
            | "gif"
            | "webp"
            | "tif"
            | "tiff"
            | "csv"
            | "ppt"
            | "pptx"
            | "zip"
            | "rar"
            | "7z"
            | "exe"
            | "dll"
            | "msi"
            | "bat"
            | "cmd"
            | "ps1"
            | "log"
            | "ini"
            | "toml"
            | "rs"
            | "py"
            | "java"
    )
}

fn is_known_abbreviation_ending(chars: &[char], index: usize) -> bool {
    let prefix = chars[..=index]
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    [
        "e.g.", "i.e.", "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "vs.", "etc.", "fig.",
        "no.", "dept.", "inc.", "ltd.",
    ]
    .iter()
    .any(|abbreviation| prefix.ends_with(abbreviation))
}

fn has_protected_colon_scheme(chars: &[char], index: usize) -> bool {
    let scheme = label_before(chars, index).to_ascii_lowercase();
    matches!(
        scheme.as_str(),
        "http" | "https" | "ftp" | "file" | "mailto" | "tel" | "urn" | "doi"
    )
}

fn previous_non_space(chars: &[char], index: usize) -> Option<char> {
    chars[..index]
        .iter()
        .rev()
        .copied()
        .find(|character| !character.is_whitespace())
}

fn next_non_space(chars: &[char], index: usize) -> Option<char> {
    chars[index + 1..]
        .iter()
        .copied()
        .find(|character| !character.is_whitespace())
}

fn next_content_index(chars: &[char], start: usize) -> Option<usize> {
    (start..chars.len()).find(|index| !chars[*index].is_whitespace())
}

fn is_cjk(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
            | '\u{3040}'..='\u{30ff}'
            | '\u{ac00}'..='\u{d7af}'
    )
}

fn is_unspaced_cjk(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
            | '\u{3040}'..='\u{30ff}'
    )
}

fn is_cjk_punctuation(character: char) -> bool {
    matches!(
        character,
        '，' | '。' | '！' | '？' | '；' | '：' | '、' | '）' | '》' | '】' | '」' | '』' | '…'
    )
}

fn is_opening_punctuation(character: char) -> bool {
    matches!(character, '(' | '[' | '{' | '“' | '‘' | '"' | '\'')
}

fn is_closing_punctuation(character: char) -> bool {
    matches!(
        character,
        '.' | ',' | ';' | ':' | '?' | '!' | ')' | ']' | '}' | '”' | '’' | '"' | '\''
    )
}

fn is_closing_delimiter(character: char) -> bool {
    matches!(character, ')' | ']' | '}' | '”' | '’' | '"' | '\'')
}

fn full_width_punctuation(character: char) -> Option<char> {
    match character {
        ',' => Some('，'),
        '.' => Some('。'),
        '?' => Some('？'),
        '!' => Some('！'),
        ';' => Some('；'),
        ':' => Some('：'),
        _ => None,
    }
}

fn append_soft_line(paragraph: &mut String, line: &str) {
    if paragraph.is_empty() {
        paragraph.push_str(line);
        return;
    }

    let previous = paragraph.chars().next_back();
    let next = line.chars().next();
    if previous == Some('\u{00ad}') {
        paragraph.pop();
    } else if needs_join_space(previous, next) {
        paragraph.push(' ');
    }
    paragraph.push_str(line);
}

fn needs_join_space(previous: Option<char>, next: Option<char>) -> bool {
    let (Some(previous), Some(next)) = (previous, next) else {
        return false;
    };
    if previous.is_whitespace()
        || next.is_whitespace()
        || is_opening_punctuation(previous)
        || is_closing_punctuation(next)
        || is_cjk_punctuation(previous)
        || matches!(previous, '-' | '/' | '\\')
    {
        return false;
    }
    if is_unspaced_cjk(previous) && is_unspaced_cjk(next) {
        return false;
    }
    true
}

fn should_end_paragraph(
    line: &str,
    index: usize,
    lines: &[Option<String>],
    typical_width: usize,
    paragraph_line_count: usize,
) -> bool {
    if lines.get(index + 1).is_none_or(Option::is_none) {
        return true;
    }
    let width = display_width(line);
    if typical_width == 0 || width.saturating_mul(100) >= typical_width.saturating_mul(64) {
        return false;
    }
    ends_sentence(line) || (paragraph_line_count > 1 && width.saturating_mul(2) < typical_width)
}

fn ends_sentence(value: &str) -> bool {
    let mut chars = value.trim_end().chars().rev();
    let mut last = chars.next();
    while last
        .is_some_and(|character| matches!(character, ')' | ']' | '}' | '”' | '’' | '"' | '\''))
    {
        last = chars.next();
    }
    last.is_some_and(|character| matches!(character, '.' | '?' | '!' | '。' | '？' | '！' | '…'))
}

fn flush_paragraph(blocks: &mut Vec<Block>, paragraph: &mut String, line_count: &mut usize) {
    if !paragraph.is_empty() {
        push_block(blocks, BlockKind::Paragraph, std::mem::take(paragraph));
    }
    *line_count = 0;
}

fn push_block(blocks: &mut Vec<Block>, kind: BlockKind, text: String) {
    blocks.push(Block { kind, text });
}

fn render_blocks(blocks: &[Block]) -> String {
    let mut output = String::new();
    for (index, block) in blocks.iter().enumerate() {
        if index > 0 {
            let previous = blocks[index - 1].kind;
            let compact = (block.kind == BlockKind::List && previous == BlockKind::List)
                || (block.kind == BlockKind::Table && previous == BlockKind::Table)
                || (block.kind == BlockKind::Code && previous == BlockKind::Code);
            output.push_str(if compact { "\n" } else { "\n\n" });
        }
        output.push_str(&block.text);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn normalizes_english_spacing_without_corrupting_machine_tokens() {
        assert_eq!(
            normalize_ocr_lines(&lines(&[
                "Hello,world!Visit example.com or email user@example.com.",
                "Pi is 3.14,time is 12:30,and the file is report.pdf."
            ])),
            "Hello, world! Visit example.com or email user@example.com. Pi is 3.14, time is 12:30, and the file is report.pdf."
        );
    }

    #[test]
    fn restores_a_full_width_period_inside_cjk_file_names_and_domains() {
        assert_eq!(normalize_ocr_lines(&lines(&["托盘。ico"])), "托盘.ico");
        assert_eq!(
            normalize_ocr_lines(&lines(&["访问example。com。"])),
            "访问example.com。"
        );
        assert_eq!(
            normalize_ocr_lines(&lines(&["句号。然后继续。"])),
            "句号。然后继续。"
        );
    }

    #[test]
    fn uses_chinese_sentence_punctuation_after_a_latin_final_token() {
        let value = "界面使用 PySide6 构建，图像处理、剪贴板操作和 OCR 由 Rust 实现，支持 Windows x86_64 与 ARM64.";
        let expected = "界面使用 PySide6 构建，图像处理、剪贴板操作和 OCR 由 Rust 实现，支持 Windows x86_64 与 ARM64。";

        assert_eq!(normalize_text_typography(value), expected);
        assert_eq!(
            normalize_text_typography_for_language(value, "zh-CN"),
            expected
        );
        assert_eq!(
            normalize_text_typography_for_language("English ends with ARM64.", "en"),
            "English ends with ARM64."
        );
        assert_eq!(
            normalize_text_typography("This is English with 中文."),
            "This is English with 中文."
        );
    }

    #[test]
    fn language_aware_typography_preserves_machine_periods_and_line_breaks() {
        assert_eq!(
            normalize_text_typography_for_language(
                "文件是托盘.ico.\r\n版本是 3.14.\n访问 example.com.",
                "zh-CN",
            ),
            "文件是托盘.ico。\r\n版本是 3.14。\n访问 example.com。"
        );
        assert_eq!(
            normalize_text_typography_for_language("Rust,支持", "zh-CN"),
            "Rust，支持"
        );
    }

    #[test]
    fn separates_a_sentence_after_a_protected_url_or_email() {
        assert_eq!(
            normalize_ocr_lines(&lines(&[
                "Visit https://example.com.Next page.",
                "Email user@example.com.Then wait."
            ])),
            "Visit https://example.com. Next page. Email user@example.com. Then wait."
        );
    }

    #[test]
    fn handles_abbreviations_acronyms_and_dotted_identifiers() {
        assert_eq!(
            normalize_ocr_lines(&lines(&[
                "Dr.Smith works for the U.S.government.",
                "Use object.method and e.g.examples from docs.rs."
            ])),
            "Dr. Smith works for the U.S. government. Use object.method and e.g. examples from docs.rs."
        );
    }

    #[test]
    fn reconstructs_english_soft_wraps_and_real_paragraphs() {
        assert_eq!(
            normalize_ocr_lines(&lines(&[
                "This is a deliberately long first line of an English paragraph",
                "that continues on the next visual line and ends here.",
                "Short ending.",
                "A new paragraph starts here and continues with more text",
                "on its next visual line."
            ])),
            "This is a deliberately long first line of an English paragraph that continues on the next visual line and ends here. Short ending.\n\nA new paragraph starts here and continues with more text on its next visual line."
        );
    }

    #[test]
    fn uses_explicit_paragraph_groups_when_the_provider_has_them() {
        let paragraphs = vec![
            lines(&["The first visual line", "continues here."]),
            lines(&["Second paragraph,without a space."]),
        ];
        assert_eq!(
            normalize_ocr_paragraphs(&paragraphs),
            "The first visual line continues here.\n\nSecond paragraph, without a space."
        );
    }

    #[test]
    fn applies_cjk_punctuation_and_line_joining_rules() {
        assert_eq!(
            normalize_ocr_lines(&lines(&["这是第一行,下一行", "继续同一个自然段."])),
            "这是第一行，下一行继续同一个自然段。"
        );
    }

    #[test]
    fn keeps_korean_word_spaces_and_western_punctuation() {
        assert_eq!(
            normalize_ocr_lines(&lines(&["안녕 하세요.반갑습니다."])),
            "안녕 하세요. 반갑습니다."
        );
    }

    #[test]
    fn preserves_lists_tables_code_and_inline_code() {
        assert_eq!(
            normalize_ocr_lines(&lines(&[
                "- First,item",
                "- Visit example.com",
                "| name | value |",
                "| a | 3.14 |",
                "Use `object.method()` and say Hello,world."
            ])),
            "- First, item\n- Visit example.com\n\n| name | value |\n| a | 3.14 |\n\nUse `object.method()` and say Hello, world."
        );
    }
}
