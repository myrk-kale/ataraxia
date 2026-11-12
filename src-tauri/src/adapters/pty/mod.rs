//! PTY adapter placeholder. Real PTY arrives in PR3.

use crate::ports::PtyHost;

#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedPty;

impl PtyHost for UnsupportedPty {
    fn supported(&self) -> bool {
        false
    }
}
