use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{Error, ErrorCode, Result};

pub fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

/// The moment `days` from now, for a note that is only good for a while.
pub fn in_days(days: i64) -> Result<String> {
    (OffsetDateTime::now_utc() + time::Duration::days(days))
        .format(&Rfc3339)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

/// Whether an RFC 3339 moment has gone by. A text that is not one is never in the past.
pub fn is_past(moment: &str) -> bool {
    OffsetDateTime::parse(moment, &Rfc3339).is_ok_and(|moment| moment <= OffsetDateTime::now_utc())
}

/// Whether the text is an RFC 3339 moment.
pub fn is_moment(text: &str) -> bool {
    OffsetDateTime::parse(text, &Rfc3339).is_ok()
}
