//! Small terminal UI layer: colors, aligned tables, number formatting and hints.
//!
//! Colors are opt-out through `NO_COLOR=1` or `--no-color`, and automatically
//! disabled when stdout is not a TTY so piped output stays clean.

use std::io::IsTerminal;

#[derive(Debug, Clone, Copy)]
pub struct Ui {
    color: bool,
}

impl Ui {
    pub fn new(force_plain: bool) -> Self {
        let no_color_env = std::env::var("NO_COLOR")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        let color = !force_plain && !no_color_env && std::io::stdout().is_terminal();
        Self { color }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }

    pub fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }

    pub fn title(&self, text: &str) {
        println!("{}", self.bold(text));
    }

    pub fn section(&self, text: &str) {
        println!("\n{}", self.bold(text));
    }

    pub fn info(&self, text: &str) {
        println!("{} {text}", self.paint("36", "==>"));
    }

    pub fn ok(&self, text: &str) {
        println!("{} {text}", self.paint("32", "[ OK ]"));
    }

    pub fn warn(&self, text: &str) {
        println!("{} {text}", self.paint("33", "[WARN]"));
    }

    pub fn error(&self, text: &str) {
        eprintln!("{} {text}", self.paint("31", "[FAIL]"));
    }

    pub fn hint(&self, text: &str) {
        println!("       {}", self.dim(text));
    }

    /// Prints `label  value` with a fixed label column.
    pub fn kv(&self, label: &str, value: &str) {
        println!("  {:<16} {}", format!("{label}:"), value);
    }

    /// Prints a bordered-free table with computed column widths.
    pub fn table(&self, headers: &[&str], rows: &[Vec<String>]) {
        if rows.is_empty() {
            println!("  {}", self.dim("(no rows)"));
            return;
        }
        let mut widths: Vec<usize> = headers.iter().map(|h| display_width(h)).collect();
        for row in rows {
            for (idx, cell) in row.iter().enumerate() {
                if idx < widths.len() {
                    widths[idx] = widths[idx].max(display_width(cell));
                }
            }
        }

        let header_line = headers
            .iter()
            .enumerate()
            .map(|(idx, head)| pad_right(head, widths[idx]))
            .collect::<Vec<_>>()
            .join("  ");
        println!("  {}", self.bold(header_line.trim_end()));
        let rule = widths
            .iter()
            .map(|w| "-".repeat(*w))
            .collect::<Vec<_>>()
            .join("  ");
        println!("  {}", self.dim(rule.trim_end()));

        for row in rows {
            let line = row
                .iter()
                .enumerate()
                .map(|(idx, cell)| {
                    let width = widths
                        .get(idx)
                        .copied()
                        .unwrap_or_else(|| display_width(cell));
                    pad_right(cell, width)
                })
                .collect::<Vec<_>>()
                .join("  ");
            println!("  {}", line.trim_end());
        }
    }
}

fn display_width(text: &str) -> usize {
    text.chars().count()
}

fn pad_right(text: &str, width: usize) -> String {
    let len = display_width(text);
    if len >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

/// Formats a float with thousands separators and a fixed number of decimals.
pub fn num(value: f64, decimals: usize) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    let negative = value < 0.0;
    let abs = value.abs();
    let rendered = format!("{abs:.decimals$}");
    let (int_part, frac_part) = match rendered.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (rendered, None),
    };
    let mut grouped = String::new();
    for (idx, ch) in int_part.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut out = grouped.chars().rev().collect::<String>();
    if let Some(frac) = frac_part {
        out.push('.');
        out.push_str(&frac);
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// Compacts large numbers into `1.23M` / `4.56B` for table cells.
pub fn compact(value: f64) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    let abs = value.abs();
    let (scaled, suffix) = if abs >= 1_000_000_000_000.0 {
        (value / 1_000_000_000_000.0, "T")
    } else if abs >= 1_000_000_000.0 {
        (value / 1_000_000_000.0, "B")
    } else if abs >= 1_000_000.0 {
        (value / 1_000_000.0, "M")
    } else if abs >= 1_000.0 {
        (value / 1_000.0, "K")
    } else {
        (value, "")
    };
    format!("{scaled:.2}{suffix}")
}

pub fn pct(value: f64, decimals: usize) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    format!("{value:+.*}%", decimals)
}

pub fn duration_ms(ms: f64) -> String {
    if !ms.is_finite() || ms < 0.0 {
        return "-".to_string();
    }
    if ms < 1_000.0 {
        format!("{ms:.0}ms")
    } else if ms < 60_000.0 {
        format!("{:.1}s", ms / 1_000.0)
    } else if ms < 3_600_000.0 {
        format!("{:.1}m", ms / 60_000.0)
    } else {
        format!("{:.1}h", ms / 3_600_000.0)
    }
}

/// `abcd…wxyz` masking for API keys, tokens and account identifiers.
pub fn mask(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= 8 {
        return "****".to_string();
    }
    format!("{}…{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

/// Reads a line from stdin; returns `None` when stdin is not interactive.
pub fn prompt_line(question: &str) -> Option<String> {
    use std::io::{stdin, stdout, Write};
    if !std::io::stdin().is_terminal() {
        return None;
    }
    print!("{question} ");
    let _ = stdout().flush();
    let mut buffer = String::new();
    if stdin().read_line(&mut buffer).is_err() {
        return None;
    }
    Some(buffer.trim().to_string())
}

pub fn confirm(question: &str) -> bool {
    match prompt_line(&format!("{question} [y/N]")) {
        Some(answer) => matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"),
        None => false,
    }
}

pub fn is_interactive() -> bool {
    std::io::stdin().is_terminal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_with_separators() {
        assert_eq!(num(1234.5, 2), "1,234.50");
        assert_eq!(num(-9876543.0, 0), "-9,876,543");
        assert_eq!(num(0.0, 2), "0.00");
        assert_eq!(num(f64::NAN, 2), "-");
    }

    #[test]
    fn compacts_large_numbers() {
        assert_eq!(compact(1_500.0), "1.50K");
        assert_eq!(compact(2_500_000.0), "2.50M");
        assert_eq!(compact(3_000_000_000.0), "3.00B");
        assert_eq!(compact(42.0), "42.00");
    }

    #[test]
    fn masks_short_and_long_values() {
        assert_eq!(mask("short"), "****");
        assert_eq!(mask("1234567890abcdef"), "1234…cdef");
    }

    #[test]
    fn formats_percent_and_duration() {
        assert_eq!(pct(1.234, 2), "+1.23%");
        assert_eq!(pct(-0.5, 1), "-0.5%");
        assert_eq!(duration_ms(500.0), "500ms");
        assert_eq!(duration_ms(2_500.0), "2.5s");
        assert_eq!(duration_ms(90_000.0), "1.5m");
    }
}
