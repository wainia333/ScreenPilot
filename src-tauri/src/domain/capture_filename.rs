use chrono::{DateTime, Datelike, Local, Timelike};

pub const DEFAULT: &str = "Screenshot_$yyyy-MM-dd_HH-mm-ss$.png";

pub fn render(template: &str, format: &str, date: DateTime<Local>) -> Result<String, String> {
    if template.trim().is_empty()
        || template.encode_utf16().count() > 180
        || template
            .chars()
            .any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
    {
        return Err("文件名不能为空，且不能包含路径或 Windows 文件名禁用字符".into());
    }
    let parts: Vec<_> = template.split('$').collect();
    if parts.len() % 2 == 0 {
        return Err("日期格式需要成对的 $，例如 $yyyy-MM-dd_HH-mm-ss$".into());
    }
    let tokens = [
        ("yyyy", format!("{:04}", date.year())),
        ("zzz", format!("{:03}", date.timestamp_subsec_millis())),
        ("yy", format!("{:02}", date.year() % 100)),
        ("MM", format!("{:02}", date.month())),
        ("dd", format!("{:02}", date.day())),
        ("HH", format!("{:02}", date.hour())),
        ("hh", format!("{:02}", date.hour12().1)),
        ("mm", format!("{:02}", date.minute())),
        ("ss", format!("{:02}", date.second())),
        ("M", date.month().to_string()),
        ("d", date.day().to_string()),
        ("H", date.hour().to_string()),
        ("h", date.hour12().1.to_string()),
        ("m", date.minute().to_string()),
        ("s", date.second().to_string()),
    ];
    let mut name = String::new();
    for (index, mut part) in parts.into_iter().enumerate() {
        if index % 2 == 0 {
            name.push_str(part);
            continue;
        }
        if part.is_empty() {
            return Err("日期格式不能为空".into());
        }
        while !part.is_empty() {
            if let Some((token, value)) = tokens.iter().find(|(token, _)| part.starts_with(token)) {
                name.push_str(value);
                part = &part[token.len()..];
            } else {
                let c = part.chars().next().unwrap();
                if c.is_ascii_alphabetic() {
                    return Err(format!("不支持的日期符号：{c}"));
                }
                name.push(c);
                part = &part[c.len_utf8()..];
            }
        }
    }
    let name = name.trim();
    let stem = name
        .rsplit_once('.')
        .filter(|(_, ext)| {
            ["png", "jpg", "jpeg", "bmp", "webp", "pdf"]
                .iter()
                .any(|e| ext.eq_ignore_ascii_case(e))
        })
        .map_or(name, |(stem, _)| stem);
    let device = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            device
                .strip_prefix(p)
                .is_some_and(|n| n.len() == 1 && ("1"..="9").contains(&n))
        });
    if stem.is_empty() || stem.ends_with(['.', ' ']) || reserved {
        return Err("请使用有效的 Windows 文件名".into());
    }
    Ok(format!("{stem}.{}", format.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    #[test]
    fn capture_filename_matches_preview_and_rejects_paths() {
        let date = Local.with_ymd_and_hms(2026, 10, 4, 21, 50, 9).unwrap();
        assert_eq!(
            render(DEFAULT, "PNG", date).unwrap(),
            "Screenshot_2026-10-04_21-50-09.png"
        );
        assert_eq!(
            render("画面_$yy-M-d_hh-mm-ss-zzz$.png", "JPG", date).unwrap(),
            "画面_26-10-4_09-50-09-000.jpg"
        );
        for template in [
            "", "../shot", "C:\\shot", "$yyyy", "$$", "CON.png", "LPT9", "$yyyy-Q$", "shot.",
        ] {
            assert!(render(template, "png", date).is_err(), "{template}");
        }
    }
}
