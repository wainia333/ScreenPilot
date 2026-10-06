use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const NATIVE_SCHEMA: &str = include_str!("capture-settings-schema.json");

const TOOLS: &[&str] = &[
    "cursor",
    "pen",
    "mosaic",
    "spotlight",
    "arrow",
    "number",
    "rect",
    "ellipse",
    "text",
    "eraser",
];
// Upgrade tool preferences without invalidating the rest of settings.json.
// Retired marks are discarded when loading pin assets.
pub fn strip_removed_tools(value: &mut Value) {
    if let Some(fields) = value.as_object_mut() {
        fields.remove("highlighter");
        if let Some(layout) = fields.get_mut("layout").and_then(Value::as_array_mut) {
            layout.retain(|entry| entry["key"] != "highlighter");
        }
    }
}
fn deserialize_tools<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, Value>, D::Error> {
    let mut value = Value::deserialize(deserializer)?;
    strip_removed_tools(&mut value);
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn deserialize_native_options<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, Value>, D::Error> {
    let mut options = BTreeMap::<String, Value>::deserialize(deserializer)?;
    // Accept old settings/imports without retaining retired pin controls.
    for key in ["pin_hover_buttons", "pin_auto_border"] {
        options.remove(key);
    }
    Ok(options)
}
fn bounded_number(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && (min..=max).contains(&v))
}
fn valid_style(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.iter().all(|(key, value)| match key.as_str() {
        "color" | "backgroundColor" | "outlineColor" | "shadowColor" => {
            value.as_str().is_some_and(|v| {
                (v.len() == 7 || v.len() == 9)
                    && v.starts_with('#')
                    && v[1..].bytes().all(|c| c.is_ascii_hexdigit())
            })
        }
        "width" => bounded_number(value, 1.0, 200.0),
        "opacity" => bounded_number(value, 0.0, 1.0),
        "radius" => bounded_number(value, 0.0, 100.0),
        "block" => bounded_number(value, 2.0, 200.0),
        "fontSize" => bounded_number(value, 6.0, 1000.0),
        "outlineWidth" => bounded_number(value, 0.0, 1.0),
        "fill" | "bold" | "italic" | "underline" | "background" | "outline" | "shadow" => {
            value.is_boolean()
        }
        "font" => value
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 200 && !v.contains(['\n', '\r', '"'])),
        "line" => value
            .as_str()
            .is_some_and(|v| ["solid", "dashed", "dashed_dense"].contains(&v)),
        "arrow" => value.as_str().is_some_and(|v| {
            [
                "single",
                "double",
                "hollow",
                "line",
                "line_double",
                "triangle",
                "triangle_double",
                "bar",
                "bar_arrow",
            ]
            .contains(&v)
        }),
        "mosaic" => value
            .as_str()
            .is_some_and(|v| ["pixelate", "blur"].contains(&v)),
        "mode" => value
            .as_str()
            .is_some_and(|v| ["freehand", "rect"].contains(&v)),
        "number" => value
            .as_str()
            .is_some_and(|v| ["solid", "hollow_bg", "hollow_all", "no_circle"].contains(&v)),
        _ => false,
    })
}
pub fn validate_tools(value: &Value) -> Result<(), String> {
    let fields = value.as_object().ok_or("工具设置必须是对象")?;
    for (key, value) in fields {
        let valid = if TOOLS.contains(&key.as_str()) {
            valid_style(value)
        } else if key == "lastRegion" {
            value.as_object().is_some_and(|r| {
                r.len() == 4
                    && ["x", "y"]
                        .iter()
                        .all(|k| bounded_number(&value[k], -100000.0, 100000.0))
                    && ["width", "height"]
                        .iter()
                        .all(|k| bounded_number(&value[k], 0.0, 32768.0))
            })
        } else if key == "layout" {
            let mut seen = BTreeSet::new();
            value.as_array().is_some_and(|items| {
                items.len() <= 30
                    && items.iter().all(|v| {
                        v.as_object().is_some_and(|o| o.len() == 2)
                            && v["key"].as_str().is_some_and(|name| {
                                (TOOLS.contains(&name)
                                    || [
                                        "long_screenshot",
                                        "save",
                                        "scan_code",
                                        "gif",
                                        "shape",
                                        "undo",
                                        "redo",
                                        "cancel",
                                        "pin",
                                        "confirm",
                                        "copy",
                                    ]
                                    .contains(&name))
                                    && seen.insert(name)
                            })
                            && v["mode"]
                                .as_str()
                                .is_some_and(|mode| ["show", "more", "hide"].contains(&mode))
                    })
            })
        } else {
            false
        };
        if !valid {
            return Err(format!("无效的工具设置：{key}"));
        }
    }
    Ok(())
}
pub fn validate_marks(value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let marks = value.as_array().ok_or("标注必须是数组")?;
    let mut points = 0usize;
    if marks.len() > 10000 {
        return Err("标注数量过多".into());
    }
    for mark in marks {
        let valid = mark["id"].as_str().is_some_and(|v| v.len() <= 100)
            && mark["tool"]
                .as_str()
                .is_some_and(|v| TOOLS.contains(&v) && !["cursor", "eraser"].contains(&v))
            && bounded_number(&mark["rotation"], -10000.0, 10000.0)
            && valid_style(&mark["style"])
            && mark
                .get("text")
                .is_none_or(|v| v.as_str().is_some_and(|s| s.len() <= 100000))
            && mark
                .get("number")
                .is_none_or(|v| bounded_number(v, -99999.0, 99999.0))
            && mark["points"].as_array().is_some_and(|items| {
                points += items.len();
                items.len() >= 2
                    && items.iter().all(|p| {
                        bounded_number(&p["x"], -100000.0, 100000.0)
                            && bounded_number(&p["y"], -100000.0, 100000.0)
                    })
            });
        if !valid || points > 250000 {
            return Err("标注内容无效或过大".into());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CaptureSettings {
    pub enabled: bool,
    pub pins_visible: bool,
    pub shortcut: String,
    #[serde(default, deserialize_with = "deserialize_native_options")]
    pub native_options: BTreeMap<String, Value>,
    #[serde(default, deserialize_with = "deserialize_tools")]
    pub tools: BTreeMap<String, Value>,
}
impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            pins_visible: true,
            shortcut: "Control+Alt+S".into(),
            native_options: BTreeMap::new(),
            tools: BTreeMap::new(),
        }
    }
}
impl CaptureSettings {
    pub fn validate(&self) -> Result<(), String> {
        let tools = serde_json::to_value(&self.tools).map_err(|e| e.to_string())?;
        if tools.to_string().len() > 128_000 {
            return Err("工具设置过大".into());
        }
        validate_tools(&tools)?;
        let schema: Vec<Value> = serde_json::from_str(NATIVE_SCHEMA).map_err(|e| e.to_string())?;
        for (key, value) in &self.native_options {
            let field = schema
                .iter()
                .find(|f| f["key"] == *key)
                .ok_or_else(|| format!("Unknown capture setting: {key}"))?;
            let default = &field["default"];
            let valid = (default.is_boolean() && value.is_boolean())
                || (default.is_number() && value.is_number())
                || (default.is_string() && value.as_str().is_some_and(|s| s.len() <= 2048));
            if !valid {
                return Err(format!("Invalid capture setting: {key}"));
            }
            if let Some(choices) = field["choices"].as_array() {
                if !choices.contains(value) {
                    return Err(format!("Unsupported capture option: {key}"));
                }
            }
            if let Some(min) = field["min"].as_f64() {
                let number = value.as_f64().unwrap_or(f64::NAN);
                if !number.is_finite()
                    || number < min
                    || number > field["max"].as_f64().unwrap_or(min)
                {
                    return Err(format!("Capture setting out of range: {key}"));
                }
            }
            if field["kind"] == "color" {
                let color = value.as_str().unwrap_or("");
                if color.len() != 7
                    || !color.starts_with('#')
                    || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(format!("Invalid capture color: {key}"));
                }
            }
            if field["kind"] == "filename" {
                super::capture_filename::render(
                    value.as_str().unwrap_or_default(),
                    "png",
                    chrono::Local::now(),
                )?;
            }
        }
        let mut used = BTreeSet::new();
        for field in schema.iter().filter(|field| field["kind"] == "shortcut") {
            let key = field["key"].as_str().unwrap_or_default();
            let value = self
                .native_options
                .get(key)
                .unwrap_or(&field["default"])
                .as_str()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if value.is_empty() {
                continue;
            }
            let mut parts: Vec<&str> = value.split('+').collect();
            let button = parts.pop().unwrap_or_default();
            let original_len = parts.len();
            parts.sort_unstable();
            parts.dedup();
            if !(1..=2).contains(&parts.len())
                || parts.len() != original_len
                || parts
                    .iter()
                    .any(|key| !matches!(*key, "ctrl" | "shift" | "alt" | "win"))
                || !matches!(
                    button,
                    "dragleft" | "dragright" | "dragmiddle" | "dragx1" | "dragx2"
                )
            {
                return Err(format!("Invalid mouse gesture: {key}"));
            }
            parts.push(button);
            if !used.insert(parts.join("+")) {
                return Err(format!("Duplicate mouse gesture: {key}"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod pin_visibility_tests {
    use super::CaptureSettings;
    #[test]
    fn old_settings_show_pins_and_hidden_preference_survives_json() {
        let old: CaptureSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(old.pins_visible);
        let hidden = CaptureSettings {
            pins_visible: false,
            ..old
        };
        let serialized = serde_json::to_value(&hidden).unwrap();
        assert_eq!(serialized["pinsVisible"], false);
        assert!(
            !serde_json::from_value::<CaptureSettings>(serialized)
                .unwrap()
                .pins_visible
        );
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jpeg_quality_settings_accept_zero_through_one_hundred() {
        for quality in [0, 85, 100] {
            let mut settings = CaptureSettings::default();
            settings
                .native_options
                .insert("screenshot_quality".into(), serde_json::json!(quality));
            assert!(settings.validate().is_ok());
            assert_eq!(
                serde_json::from_str::<CaptureSettings>(&serde_json::to_string(&settings).unwrap())
                    .unwrap(),
                settings
            );
        }
        for quality in [-1, 101] {
            let mut settings = CaptureSettings::default();
            settings
                .native_options
                .insert("screenshot_quality".into(), serde_json::json!(quality));
            assert!(settings.validate().is_err());
        }
        let schema: Vec<Value> = serde_json::from_str(NATIVE_SCHEMA).unwrap();
        assert_eq!(
            schema
                .iter()
                .find(|field| field["key"] == "screenshot_quality")
                .unwrap()["default"],
            100
        );
    }
    #[test]
    fn rejects_retired_highlighter_preferences_and_marks() {
        use serde_json::json;
        let raw = json!({"tools":{"highlighter":{"width":15,"color":"#FFFF00"},"pen":{"width":4},"layout":[{"key":"highlighter","mode":"show"},{"key":"save","mode":"show"}]}});
        let settings: CaptureSettings = serde_json::from_value(raw.clone()).unwrap();
        assert!(settings.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&settings.tools).unwrap(),
            json!({"pen":{"width":4},"layout":[{"key":"save","mode":"show"}]})
        );
        assert!(validate_tools(&raw["tools"]).is_err());
        assert!(validate_tools(&json!({"layout":[{"key":"highlighter","mode":"show"}]})).is_err());
        let mark = json!({"id":"old","tool":"highlighter","rotation":0,"points":[{"x":200,"y":240},{"x":600,"y":240}],"style":{"width":15,"color":"#FFFF00"}});
        assert!(validate_marks(&json!([mark])).is_err());
    }
    #[test]
    fn accepts_grouped_and_legacy_shape_layouts_and_defaults_pixel_grid_on() {
        use serde_json::json;
        assert!(validate_tools(&json!({"layout":[{"key":"shape","mode":"more"}],"rect":{"width":4},"ellipse":{"width":7}})).is_ok());
        assert!(validate_tools(
            &json!({"layout":[{"key":"rect","mode":"show"},{"key":"ellipse","mode":"hide"}]})
        )
        .is_ok());
        assert!(validate_tools(
            &json!({"layout":[{"key":"shape","mode":"show"},{"key":"shape","mode":"hide"}]})
        )
        .is_err());
        let schema: Vec<Value> = serde_json::from_str(NATIVE_SCHEMA).unwrap();
        assert_eq!(
            schema
                .iter()
                .find(|field| field["key"] == "magnifier_grid")
                .unwrap()["default"],
            json!(true)
        );
        let mut settings = CaptureSettings::default();
        settings
            .native_options
            .insert("magnifier_grid".into(), json!(false));
        assert!(settings.validate().is_ok());
    }
    #[test]
    fn capture_tool_state_rejects_corrupt_disk_and_window_payloads() {
        use serde_json::json;
        assert!(validate_tools(&json!({"text":{"fontSize":14,"font":"Microsoft YaHei UI"},"lastRegion":{"x":-1280,"y":0,"width":1920,"height":1080}})).is_ok());
        for value in [
            json!(null),
            json!({"pen":{"width":-1}}),
            json!({"text":{"fontSize":"large"}}),
            json!({"layout":[{"key":"ocr","mode":"show"}]}),
            json!({"layout":[{"key":"pen","mode":"show"},{"key":"pen","mode":"hide"}]}),
        ] {
            assert!(validate_tools(&value).is_err());
        }
        let mut mark = json!({"id":"one","tool":"arrow","rotation":0,"points":[{"x":10,"y":20},{"x":200,"y":60}],"style":{"width":9,"arrow":"single"}});
        assert!(validate_marks(&json!([mark.clone()])).is_ok());
        mark["points"][0]["x"] = json!("NaN");
        assert!(validate_marks(&json!([mark])).is_err());
    }
    #[test]
    fn migrates_old_preview_without_overriding_upstream_tool_defaults() {
        let settings: CaptureSettings =
            serde_json::from_str(r##"{"shortcut":"Alt+S","color":"#e86e56","recordFps":15}"##)
                .unwrap();
        assert_eq!(settings.shortcut, "Alt+S");
        assert!(settings.native_options.is_empty());
        assert_eq!(
            serde_json::from_str::<CaptureSettings>(include_str!("capture-defaults.json")).unwrap(),
            CaptureSettings::default()
        );
    }
    #[test]
    fn accepts_upstream_defaults_and_rejects_removed_features() {
        let schema: Vec<Value> = serde_json::from_str(NATIVE_SCHEMA).unwrap();
        let mut settings = CaptureSettings {
            native_options: schema
                .iter()
                .map(|f| (f["key"].as_str().unwrap().into(), f["default"].clone()))
                .collect(),
            ..Default::default()
        };
        settings.validate().unwrap();
        settings
            .native_options
            .insert("ocr_enabled".into(), true.into());
        assert!(settings.validate().is_err());
        settings.native_options.remove("ocr_enabled");
        settings
            .native_options
            .insert("gif_fps".into(), 10000.into());
        assert!(settings.validate().is_err());
    }
}
