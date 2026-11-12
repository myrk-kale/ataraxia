use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{Error, ErrorCode, Result};

pub fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}
