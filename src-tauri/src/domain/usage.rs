//! How much of a provider's subscription limits the user has spent.
//!
//! Some providers cap use per account in rolling windows (Claude and Codex: one of five hours
//! and one of a week). The agent process reports where it stands; Ataraxia only relays it, so
//! a provider that says nothing shows nothing.

use serde::{Deserialize, Serialize};

use super::agent::ProviderKind;

/// Which of the two limits a window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageWindowKind {
    FiveHour,
    Weekly,
}

impl UsageWindowKind {
    /// Which limit a window of `minutes` is, for providers that only say how long it lasts.
    /// Anything up to half a day is the short limit.
    pub fn from_minutes(minutes: i64) -> Self {
        if minutes <= 12 * 60 {
            Self::FiveHour
        } else {
            Self::Weekly
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub kind: UsageWindowKind,
    /// 0 to 100.
    pub used_percent: u8,
    /// When the window starts over, in Unix seconds, if the provider said.
    pub resets_at: Option<i64>,
}

impl UsageWindow {
    /// A window from a share that may come out of range.
    pub fn new(kind: UsageWindowKind, used_percent: f64, resets_at: Option<i64>) -> Self {
        let used = if used_percent.is_finite() {
            used_percent.round().clamp(0.0, 100.0)
        } else {
            0.0
        };
        Self {
            kind,
            used_percent: used as u8,
            resets_at,
        }
    }
}

/// The latest known state of one provider's limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider: ProviderKind,
    /// The launch profile (account) the limits are of; `None` for the default way of starting.
    #[serde(default)]
    pub profile: Option<String>,
    /// The subscription, when the provider names it (`pro`, `plus`...).
    #[serde(default)]
    pub plan: Option<String>,
    /// At most one window of each kind, the short one first.
    pub windows: Vec<UsageWindow>,
    /// When this was last reported, in Unix seconds.
    pub updated_at: i64,
}

impl ProviderUsage {
    /// Puts a report over what was known: a window the report leaves out keeps its old value
    /// (a provider may report one window at a time).
    pub fn merged(
        provider: ProviderKind,
        profile: Option<String>,
        previous: Option<&ProviderUsage>,
        plan: Option<String>,
        windows: Vec<UsageWindow>,
        now: i64,
    ) -> Self {
        let mut all: Vec<UsageWindow> = previous.map(|old| old.windows.clone()).unwrap_or_default();
        for window in windows {
            match all.iter_mut().find(|item| item.kind == window.kind) {
                Some(slot) => *slot = window,
                None => all.push(window),
            }
        }
        all.sort_by_key(|window| match window.kind {
            UsageWindowKind::FiveHour => 0,
            UsageWindowKind::Weekly => 1,
        });
        Self {
            provider,
            profile,
            plan: plan.or_else(|| previous.and_then(|old| old.plan.clone())),
            windows: all,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_share_out_of_range_is_held_to_zero_through_a_hundred() {
        let high = UsageWindow::new(UsageWindowKind::Weekly, 130.0, None);
        let low = UsageWindow::new(UsageWindowKind::Weekly, -4.0, None);
        let odd = UsageWindow::new(UsageWindowKind::Weekly, f64::NAN, None);
        assert_eq!(
            (high.used_percent, low.used_percent, odd.used_percent),
            (100, 0, 0)
        );
    }

    #[test]
    fn the_length_of_a_window_says_which_limit_it_is() {
        assert_eq!(
            UsageWindowKind::from_minutes(300),
            UsageWindowKind::FiveHour
        );
        assert_eq!(
            UsageWindowKind::from_minutes(10_080),
            UsageWindowKind::Weekly
        );
    }

    #[test]
    fn a_report_of_one_window_keeps_the_other() {
        let first = ProviderUsage::merged(
            ProviderKind::Codex,
            None,
            None,
            Some("pro".into()),
            vec![
                UsageWindow::new(UsageWindowKind::Weekly, 40.0, Some(9)),
                UsageWindow::new(UsageWindowKind::FiveHour, 5.0, Some(3)),
            ],
            100,
        );
        assert_eq!(first.windows[0].kind, UsageWindowKind::FiveHour);
        let next = ProviderUsage::merged(
            ProviderKind::Codex,
            None,
            Some(&first),
            None,
            vec![UsageWindow::new(UsageWindowKind::FiveHour, 20.0, Some(3))],
            200,
        );
        assert_eq!(next.windows.len(), 2);
        assert_eq!(next.windows[0].used_percent, 20);
        assert_eq!(next.windows[1].used_percent, 40);
        assert_eq!(next.plan.as_deref(), Some("pro"));
        assert_eq!(next.updated_at, 200);
    }
}
