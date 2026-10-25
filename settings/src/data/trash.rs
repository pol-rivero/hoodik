use serde::{Deserialize, Serialize};

/// How long deleted items stay in their owner's trash. The value is copied
/// onto each item when it is trashed, so changing it only affects items
/// deleted afterwards.
///
/// Signed so that a negative value reaches the range check and is refused as
/// a validation error rather than as a malformed body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trash {
    #[serde(
        default = "default_retention_days",
        serialize_with = "serialize_in_range"
    )]
    retention_days: i64,
}

pub const MIN_RETENTION_DAYS: i64 = 1;
pub const MAX_RETENTION_DAYS: i64 = 3650;

fn default_retention_days() -> i64 {
    30
}

/// Written back the way it is used, so an out-of-range value edited into the
/// settings file shows up corrected in the admin form instead of failing
/// every later save with a validation error.
fn serialize_in_range<S: serde::Serializer>(days: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_i64((*days).clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS))
}

impl Default for Trash {
    fn default() -> Self {
        Self {
            retention_days: default_retention_days(),
        }
    }
}

impl Trash {
    /// Kept inside the allowed range even when the settings file was edited
    /// by hand; the admin route refuses anything outside it.
    pub fn retention_days(&self) -> i64 {
        self.retention_days
            .clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS)
    }

    pub fn set_retention_days(&mut self, days: i64) {
        self.retention_days = days;
    }

    /// The validation rule the stored value breaks, if any: `"min"` or `"max"`.
    pub fn retention_days_violation(&self) -> Option<&'static str> {
        if self.retention_days < MIN_RETENTION_DAYS {
            Some("min")
        } else if self.retention_days > MAX_RETENTION_DAYS {
            Some("max")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Trash;
    use crate::data::Data;

    #[test]
    fn default_settings_keep_trash_for_thirty_days() {
        assert_eq!(Data::default().trash.retention_days(), 30);
    }

    #[test]
    fn settings_written_before_trash_existed_get_the_default() {
        let data: Data = serde_json::from_str(
            r#"{"users":{"quota_bytes":null,"allow_register":true,"enforce_email_activation":false,"email_whitelist":null,"email_blacklist":null}}"#,
        )
        .unwrap();
        assert_eq!(data.trash.retention_days(), 30);
    }

    #[test]
    fn empty_trash_object_gets_the_default() {
        let trash: Trash = serde_json::from_str("{}").unwrap();
        assert_eq!(trash.retention_days(), 30);
    }

    #[test]
    fn a_hand_edited_value_stays_in_range() {
        let trash: Trash = serde_json::from_str(r#"{"retention_days":0}"#).unwrap();
        assert_eq!(trash.retention_days(), 1);
        assert_eq!(trash.retention_days_violation(), Some("min"));
        let trash: Trash = serde_json::from_str(r#"{"retention_days":99999}"#).unwrap();
        assert_eq!(trash.retention_days(), 3650);
        assert_eq!(trash.retention_days_violation(), Some("max"));
        assert_eq!(Trash::default().retention_days_violation(), None);
        assert_eq!(
            serde_json::to_string(&trash).unwrap(),
            r#"{"retention_days":3650}"#
        );
    }

    #[test]
    fn retention_round_trips() {
        let mut trash = Trash::default();
        trash.set_retention_days(7);
        let json = serde_json::to_string(&trash).unwrap();
        let parsed: Trash = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.retention_days(), 7);
    }
}
